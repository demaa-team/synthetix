'use strict';

const { contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { currentTime, toUnit } = require('../utils')();

const { mockToken, setupAllContracts } = require('./setup');

const { toBytes32 } = require('../..');

contract('OTC', async accounts => {
	let synthetix, usdt, otc, exchangeRates, snxRate;

	const [, owner, oracle, , address1, address2, address3] = accounts;

	const [DEM, sUSD] = ['DEM', 'sUSD'].map(toBytes32);

	// Run once at beginning - snapshots will take care of resetting this before each test
	before(async () => {
		// Mock sUSD as Depot only needs its ERC20 methods (System Pause will not work for suspending sUSD transfers)
		[{ token: usdt }] = await Promise.all([
			mockToken({ accounts, synth: 'USDT', name: 'Tether USD', symbol: 'USDT' }),
		]);

		({ OTC: otc, ExchangeRates: exchangeRates, Synthetix: synthetix } = await setupAllContracts({
			accounts,
			mocks: {
				// mocks necessary for address resolver imports
				ERC20USDT: usdt,
			},
			contracts: ['OTC', 'AddressResolver', 'ExchangeRates', 'SystemStatus', 'Synthetix'],
		}));
	});

	addSnapshotBeforeRestoreAfterEach();

	const hash = toBytes32('0x01');

	beforeEach(async () => {
		const timestamp = await currentTime();

		// add underlying assets
		assert.equal(await otc.underlyingAssetsCount(), 0);
		await otc.addAsset([toBytes32('USDT')], [usdt.address]);
		assert.equal(await otc.underlyingAssetsCount(), 1);
		await otc.removeAsset(toBytes32('USDT'));
		assert.equal(await otc.underlyingAssetsCount(), 0);
		await otc.addAsset([toBytes32('USDT')], [usdt.address]);
		assert.equal(await otc.underlyingAssetsCount(), 1);

		snxRate = toUnit('8');

		await exchangeRates.updateRates([DEM], [snxRate], timestamp, {
			from: oracle,
		});

		const tx = await otc.registerProfile(hash, { from: address1 });
		assert.eventEqual(tx, 'RegisterProfile', { from: address1, ipfsHash: hash });
	});

	it('check initial state', async () => {
		// console.log(`result ${toUnit('0.5')}`);
		assert.bnEqual(await otc.takerCRatio(), toUnit('0.2'));
		assert.bnEqual(await otc.makerCRatio(), toUnit('0.1'));
		assert.equal(await otc.isResolverCached(), true);
		const expectDeps = ['Synthetix', 'ExchangeRates'];
		const deps = await otc.resolverAddressesRequired();
		for (const dep of deps) {
			assert.equal(expectDeps.includes(web3.utils.hexToString(dep)), true);
		}
	});

	describe('check profile and order', () => {
		let result;
		let tx;

		beforeEach(async () => {
			result = await otc.profiles(address1);
			assert.equal(result.ipfsHash, hash);
			console.log(
				`address hash: ${result.ipfsHash}\n\t-- create time ${result.cTime}\n\t-- update time ${result.uTime}`
			);
		});

		it('check reigster functions', async () => {
			assert.equal(await otc.hasProfile(address1), true);
			assert.equal(await otc.hasProfile(address2), false);

			result = await otc.profiles(address2);
			console.log(
				`address2 hash: ${result.ipfsHash}\n\t-- create time ${result.cTime}\n\t-- update time ${result.uTime}`
			);

			console.log(`user count ${await otc.getUserCount()}`);
			assert.equal(await otc.getUserCount(), 1);

			const hash2 = toBytes32('0x02');
			await otc.updateProfile(hash2, { from: address1 });
			result = await otc.profiles(address1);
			assert.equal(result.ipfsHash, hash2);

			// unhappy path
			await assert.revert(otc.updateProfile(hash2, { from: address2 }), 'Profile dose not exist!');

			// destroy profile
			await assert.revert(otc.destroyProfile({ from: address2 }), 'Profile dose not exist!');
			const tx = await otc.destroyProfile({ from: address1 });
			assert.eventEqual(tx, 'DestroyProfile', { from: address1 });

			console.log(`user count ${await otc.getUserCount()}`);
			assert.equal(await otc.getUserCount(), 0);
		});

		describe('check  order', () => {
			beforeEach(async () => {
				// await otc.openOrder(0, toUnit('6.33'), toUnit('100'), {from:address1});
				console.log(`balanceof: ${await usdt.balanceOf(owner)}`);
				console.log(`totalSupply: ${await usdt.totalSupply()}`);

				await usdt.transfer(address1, toUnit('1000'), { from: owner });
				console.log(`usdt balanceof address1 before open order: ${await usdt.balanceOf(address1)}`);
				await usdt.approve(otc.address, toUnit('100'), { from: address1 });
				tx = await otc.openOrder(
					toBytes32('USDT'),
					toBytes32('CNY'),
					toUnit('6.33'),
					toUnit('100'),
					{ from: address1 }
				);
				assert.eventEqual(tx, 'OpenOrder', {
					from: address1,
					orderID: 0,
				});
				console.log(`locked amount ${await otc.lockedAsset(toUnit('50'), toUnit('0.2'))}`);
				console.log(`maxExchangeableAsset: ${await otc.maxExchangeableAsset(address1)}`);
				let order = await otc.orders(address1);
				assert.bnEqual(order.price, toUnit('6.33'));
				assert.bnEqual(await otc.orderCount(), 1);
				console.log(`order info :\n\t
				order id: ${order.orderID}\n\t
				order coinCode: ${order.coinCode}\n\t
				order currencyCode: ${order.currencyCode}\n\t
				order price: ${order.price}\n\t
				order leftAmount: ${order.leftAmount}\n\t
				order lockedAmount: ${order.lockedAmount}\n\t
				order cTime: ${order.cTime}\n\t
				order uTime: ${order.uTime}\n\t
				`);
				console.log(`usdt balanceof address1 after open order: ${await usdt.balanceOf(address1)}`);
				// cant decrease amount
				await assert.revert(
					otc.decreaseAmount(toUnit('0'), { from: address1 }),
					'Decrease amount should gt than 0!'
				);
				await assert.revert(
					otc.decreaseAmount(toUnit('101'), { from: address1 }),
					'Leftamount is insufficient!'
				);
				await assert.revert(otc.decreaseAmount(toUnit('50')), 'Order dose not exists!');
				await otc.decreaseAmount(toUnit('50'), { from: address1 });
				console.log(`usdt balanceof address1 after decrease 50: ${await usdt.balanceOf(address1)}`);
				let o = await otc.orders(address1);
				console.log(`left amount: ${o.leftAmount}`);
				assert.bnEqual(o.leftAmount, toUnit('50'));
				await usdt.approve(otc.address, toUnit('50'), { from: address1 });
				await otc.increaseAmount(toUnit('50'), { from: address1 });
				console.log(`usdt balanceof address1 after increase 50: ${await usdt.balanceOf(address1)}`);
				o = await otc.orders(address1);
				console.log(`left amount: ${o.leftAmount}`);
				assert.bnEqual(o.leftAmount, toUnit('100'));

				await assert.equal(await otc.hasOrder(address1), true);

				await synthetix.transfer(address2, toUnit('10000'), { from: owner });
				console.log(`address2 balance of snx: ${await synthetix.balanceOf(address2)}`);
				await synthetix.approve(otc.address, await synthetix.balanceOf(address2), {
					from: address2,
				});
				console.log(
					`usdt allowance of otc: ${await synthetix.allowance(address2, otc.address, {
						from: address2,
					})}`
				);
				console.log(`address2 maxTradeAmount: ${await otc.maxTradeAmount(address2)}`);

				// try make deal from address2 to address1
				await assert.revert(
					otc.makeDeal(address2, toUnit('100'), { from: address2 }),
					'Can not trade with self!'
				);

				await assert.equal(await otc.hasOrder(address1), true);
				tx = await otc.makeDeal(address1, toUnit('50'), { from: address2 });
				for (const txLog of tx.logs) {
					console.log(`console.log event: ${txLog.event}`);
				}
				assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
					maker: address1,
					taker: address2,
					dealID: 0,
					dealState: 0,
				});
				console.log(`address2 balance of snx after deal: ${await synthetix.balanceOf(address2)}`);

				// try to close order with pending deals

				await assert.revert(otc.closeOrder({ from: address3 }), 'Profile dose not exist!');
				await assert.revert(otc.closeOrder(), 'Profile dose not exist!');
				await assert.revert(otc.closeOrder({ from: address1 }), 'Has pending deals!');

				assert.equal(await otc.orderCount(), 1);
				assert.equal(await otc.dealCount(), 1);
				assert.equal(await otc.hasDeal(0), true);
				console.log(
					`dem amount with 50 usd: ${await exchangeRates.effectiveValue(sUSD, toUnit('50'), DEM)}`
				);
				console.log(`collo amount: ${await otc.lockedAsset(toUnit('6.25'), toUnit('0.2'))}`);
				const dealInfo = await otc.deals(0);
				console.log(`deal info:
		\n\tid: ${dealInfo.dealID}
		\n\t deal id: ${dealInfo.orderID}
		\n\toinCode: ${dealInfo.coinCode}
		\n\turrencyCode: ${dealInfo.currencyCode}
		\n\tprice: ${dealInfo.price}
		\n\tamount: ${dealInfo.amount}
		\n\tcollateral: ${dealInfo.collateral}
		\n\tlockedAmount: ${dealInfo.lockedAmount}
		\n\tcTime: ${dealInfo.cTime}
		\n\tuTime: ${dealInfo.uTime}
		\n\tmaker: ${dealInfo.maker}
		\n\ttaker: ${dealInfo.taker}
		\n\tdealState: ${dealInfo.dealState}`);

				order = await otc.orders(address1);
				console.log(`order after deal :\n\t
		order id: ${order.orderID}\n\t
		order coinCode: ${order.coinCode}\n\t
		order currencyCode: ${order.currencyCode}\n\t
		order price: ${order.price}\n\t
		order leftAmount: ${order.leftAmount}\n\t
		order lockedAmount: ${order.lockedAmount}\n\t
		order cTime: ${order.cTime}\n\t
		order uTime: ${order.uTime}\n\t
		`);

				// check balance
				console.log(`address1 usdt balance: ${await usdt.balanceOf(address1)}`);
				console.log(`address2 dem balance: ${await synthetix.balanceOf(address2)}`);
			});

			it('check cancel deal', async () => {
				// cancel deal
				await assert.revert(otc.cancelDeal(1, { from: address2 }), 'Deal dose not exist!');
				await assert.revert(otc.cancelDeal(0, { from: address1 }), 'Only taker can cancel deal!');

				tx = await otc.cancelDeal(0, { from: address2 });
				assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
					maker: address1,
					taker: address2,
					dealID: 0,
					dealState: 1,
				});
				const order = await otc.orders(address1);
				console.log(`Order after canceled :\n\t
				order id: ${order.orderID}\n\t
				order coinCode: ${order.coinCode}\n\t
				order currencyCode: ${order.currencyCode}\n\t
				order price: ${order.price}\n\t
				order leftAmount: ${order.leftAmount}\n\t
				order lockedAmount: ${order.lockedAmount}\n\t
				order cTime: ${order.cTime}\n\t
				order uTime: ${order.uTime}\n\t
				`);
				const dealInfo = await otc.deals(0);
				console.log(`deal after canceled:
				\n\tid: ${dealInfo.dealID}
				\n\t deal id: ${dealInfo.orderID}
				\n\toinCode: ${dealInfo.coinCode}
				\n\turrencyCode: ${dealInfo.currencyCode}
				\n\tprice: ${dealInfo.price}
				\n\tamount: ${dealInfo.amount}
				\n\tcollateral: ${dealInfo.collateral}
				\n\tlockedAmount: ${dealInfo.lockedAmount}
				\n\tcTime: ${dealInfo.cTime}
				\n\tuTime: ${dealInfo.uTime}
				\n\tmaker: ${dealInfo.maker}
				\n\ttaker: ${dealInfo.taker}
				\n\tdealState: ${dealInfo.dealState}`);
				console.log(
					`address2 balance of snx after deal canceled: ${await synthetix.balanceOf(address2)}`
				);
				await assert.revert(otc.confirmDeal(0, { from: address1 }), 'Deal should be confirming!');

				// try close order
				console.log('close order after canceled deal!');
				tx = await otc.closeOrder({ from: address1 });
				assert.eventEqual(tx, 'CloseOrder', { from: address1, orderID: 0 });
				// check balance
				console.log(`address1 usdt balance: ${await usdt.balanceOf(address1)}`);
				console.log(`address2 dem balance: ${await synthetix.balanceOf(address2)}`);
				console.log(`otc usdt balance: ${await usdt.balanceOf(otc.address)}`);
			});

			it('check confirm deal', async () => {
				await assert.revert(otc.confirmDeal(1), 'Deal dose not exist!');
				await assert.revert(otc.confirmDeal(0, { from: address2 }), 'Only maker can confirm deal!');
				console.log(`otc usdt balance before deal confirmed: ${await usdt.balanceOf(otc.address)}`);
				console.log(
					`address2 usdt balance before deal confirmed: ${await usdt.balanceOf(address2)}`
				);
				tx = await otc.confirmDeal(0, { from: address1 });
				assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
					maker: address1,
					taker: address2,
					dealID: 0,
					dealState: 2,
				});
				console.log(`otc usdt balance after deal confirmed: ${await usdt.balanceOf(otc.address)}`);
				console.log(
					`address2 usdt balance after deal confirmed: ${await usdt.balanceOf(address2)}`
				);
				const order = await otc.orders(address1);
				console.log(`Order after confirmed :\n\t
				order id: ${order.orderID}\n\t
				order coinCode: ${order.coinCode}\n\t
				order currencyCode: ${order.currencyCode}\n\t
				order price: ${order.price}\n\t
				order leftAmount: ${order.leftAmount}\n\t
				order lockedAmount: ${order.lockedAmount}\n\t
				order cTime: ${order.cTime}\n\t
				order uTime: ${order.uTime}\n\t
				`);
				const dealInfo = await otc.deals(0);
				console.log(`deal info after confimed:
		\n\tid: ${dealInfo.dealID}
		\n\t deal id: ${dealInfo.orderID}
		\n\toinCode: ${dealInfo.coinCode}
		\n\turrencyCode: ${dealInfo.currencyCode}
		\n\tprice: ${dealInfo.price}
		\n\tamount: ${dealInfo.amount}
		\n\tcollateral: ${dealInfo.collateral}
		\n\tlockedAmount: ${dealInfo.lockedAmount}
		\n\tcTime: ${dealInfo.cTime}
		\n\tuTime: ${dealInfo.uTime}
		\n\tmaker: ${dealInfo.maker}
		\n\ttaker: ${dealInfo.taker}
		\n\tdealState: ${dealInfo.dealState}`);

				// mirgrate
				/*
						console.log(`try to migrate!`);
						console.log(`otc usdt balance before migrate: ${await usdt.balanceOf(otc.address)}`);
						console.log(`otc dem balance before migrate: ${await synthetix.balanceOf(otc.address)}`);
						tx = await otc.migrate([toBytes32('USDT')], address3, {from:owner});
						console.log(`otc usdt balance after migrate: ${await usdt.balanceOf(otc.address)}`);
						console.log(`otc dem balance after migrate: ${await synthetix.balanceOf(otc.address)}`);
						console.log(`address3 usdt balance after migrate: ${await usdt.balanceOf(address3)}`);
						console.log(`address3 dem balance after migrate: ${await synthetix.balanceOf(address3)}`);
					*/
				// try close order
				console.log('close order after confirmed deal!');
				tx = await otc.closeOrder({ from: address1 });
				assert.eventEqual(tx, 'CloseOrder', { from: address1, orderID: 0 });
				// check balance
				console.log(`address1 usdt balance: ${await usdt.balanceOf(address1)}`);
				console.log(`address2 usdt balance: ${await usdt.balanceOf(address2)}`);
				console.log(`address2 dem balance: ${await synthetix.balanceOf(address2)}`);
				console.log(`otc usdt balance: ${await usdt.balanceOf(otc.address)}`);

				await otc.setMinTradeAmount(0, { from: owner });
				await assert.revert(otc.redeemCollateral(1, { from: address1 }), 'Deal dose not exist!');
				await assert.revert(
					otc.redeemCollateral(0, { from: address1 }),
					'Only taker can redeem collateral'
				);
				await assert.revert(
					otc.redeemCollateral(0, { from: address2 }),
					'Frozen period dose not end!'
				);
				console.log(`remainning frozen perod: ${await otc.leftFrozenTime(0)}`);
				tx = await otc.setDealFrozenPeriod(0, { from: owner });
				await otc.redeemCollateral(0, { from: address2 });
				console.log(`address2 balance of snx: ${await synthetix.balanceOf(address2)}`);
			});
		});
	}); // end describle
});
