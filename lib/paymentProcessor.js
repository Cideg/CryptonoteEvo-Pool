var fs = require('fs');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);


var logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);


log('info', logSystem, 'Started');


function runInterval(){
    async.waterfall([

        //Get workers from workers set.
        function(callback){
            redisClient.smembers(config.coin + ':workers', function(error, result) {
                if (error) {
                    log('error', logSystem, 'Error trying to get worker balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, result);
            });
        },

        //Get worker balances
        function(workers, callback){
            var redisCommands = workers.map(function(k){
                return ['hget', config.coin + ':workers:' + k, 'balance'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }
                var balances = {};
                for (var i = 0; i < replies.length; i++){
                    var workerId = workers[i];
                    balances[workerId] = parseInt(replies[i]) || 0
                }
                callback(null, balances);
            });
        },

        //Filter workers under balance threshold for payment
        function(balances, callback){

            var payments = {};

            for (var worker in balances){
                var balance = balances[worker];
                if (balance >= config.payments.minPayment){
                    var remainder = balance % config.payments.denomination;
                    var payout = balance - remainder;
					// if use dynamic transfer fee, fee will be subtracted from miner's payout
					if(config.payments.useDynamicTransferFee && config.payments.minerPayFee){
						payout -= config.payments.transferFeePerPayee;
					}
                    if (payout < 0) continue;
                    payments[worker] = payout;
                }
            }

            if (Object.keys(payments).length === 0){
                log('info', logSystem, 'No workers\' balances reached the minimum payment threshold');
                callback(true);
                return;
            }

            var transferCommands = [];
            var addresses = 0;
            var commandAmount = 0;
            var commandIndex = 0;
			
			for (var worker in payments){
                var amount = parseInt(payments[worker]);
				if(config.payments.maxTransactionAmount && amount + commandAmount > config.payments.maxTransactionAmount) {
		            amount = config.payments.maxTransactionAmount - commandAmount;
	            }
				
				if(!transferCommands[commandIndex]) {
					transferCommands[commandIndex] = {
						redis: [],
						amount : 0,
						rpc: {
							destinations: [],
							fee: config.payments.transferFee,
							mixin: config.payments.mixin,
							unlock_time: 0
						}
					};
				}
				
                transferCommands[commandIndex].rpc.destinations.push({amount: amount, address: worker});
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
				if(config.payments.useDynamicTransferFee && config.payments.minerPayFee){
					transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -config.payments.transferFeePerPayee]);
				}
				transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
                transferCommands[commandIndex].amount += amount;

                addresses++;
				commandAmount += amount;
				
				// update payment fee if use dynamic transfer fee
				if(config.payments.useDynamicTransferFee){
					transferCommands[commandIndex].rpc.fee = config.payments.transferFeePerPayee * addresses;
				}
				
                if (addresses >= config.payments.maxAddresses || ( config.payments.maxTransactionAmount && commandAmount >= config.payments.maxTransactionAmount)) {
					commandIndex++;
                    addresses = 0;
					commandAmount = 0;
                }
            }

            var timeOffset = 0;

            async.filter(transferCommands, function(transferCmd, cback){
                apiInterfaces.rpcWallet('transfer', transferCmd.rpc, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with transfer RPC request to wallet daemon %j', [error]);
                        log('error', logSystem, 'Payments failed to send to %j', transferCmd.rpc.destinations);
                        cback(false);
                        return;
                    }

                    var now = (timeOffset++) + Date.now() / 1000 | 0;
                    var txHash = result.tx_hash.replace('<', '').replace('>', '');


                    transferCmd.redis.push(['zadd', config.coin + ':payments:all', now, [
                        txHash,
                        transferCmd.amount,
                        transferCmd.rpc.fee,
                        transferCmd.rpc.mixin,
                        Object.keys(transferCmd.rpc.destinations).length
                    ].join(':')]);


                    for (var i = 0; i < transferCmd.rpc.destinations.length; i++){
                        var destination = transferCmd.rpc.destinations[i];
                        transferCmd.redis.push(['zadd', config.coin + ':payments:' + destination.address, now, [
                            txHash,
                            destination.amount,
                            transferCmd.rpc.fee,
                            transferCmd.rpc.mixin
                        ].join(':')]);
                    }


                    log('info', logSystem, 'Payments sent via wallet daemon %j', [result]);
                    redisClient.multi(transferCmd.redis).exec(function(error, replies){
                        if (error){
                            log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error]);
                            log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.destinations);
                            cback(false);
                            return;
                        }
                        cback(true);
                    });
                });
            }, function(succeeded){
                var failedAmount = transferCommands.length - succeeded.length;
                log('info', logSystem, 'Payments splintered and %d successfully sent, %d failed', [succeeded.length, failedAmount]);
                callback(null);
            });

        }

    ], function(error, result){
        setTimeout(runInterval, config.payments.interval * 1000);
    });
}

runInterval();
