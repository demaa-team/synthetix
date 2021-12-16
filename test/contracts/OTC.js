'use strict';

const { contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { currentTime, toUnit } = require('../utils')();

const { mockToken, setupAllContracts } = require('./setup');

const { toBytes32 } = require('../..');

contract('OTC', async accounts => {
	let synthetix, usdt, otc, exchangeRates, snxRate;

	const [, owner, oracle, , address1, address2] = accounts;

	const [DEM] = ['DEM'].map(toBytes32);

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

		snxRate = toUnit('8');

		await exchangeRates.updateRates([DEM], [snxRate], timestamp, {
			from: oracle,
		});

		const tx = await otc.registerProfile(hash, { from: address1 });
		assert.eventEqual(tx, 'RegisterProfile', { from: address1, ipfsHash: hash });
	});

	it('check initial state', async () => {
		// console.log(`result ${toUnit('0.5')}`);
		assert.bnEqual(await otc.getCollateralRatio(), toUnit('0.5'));
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
				console.log(`usdt balanceof address1: ${await usdt.balanceOf(address1)}`);
				await usdt.approve(otc.address, toUnit('100'), { from: address1 });
				tx = await otc.openOrder(0, toUnit('6.33'), toUnit('100'), { from: address1 });
				assert.eventEqual(tx, 'OpenOrder', {
					from: address1,
					orderID: 0,
					code: 0,
					price: toUnit('6.33'),
					amount: toUnit('100'),
				});
				assert.bnEqual(await otc.orderCount(), 1);

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
				let o = await otc.orders(address1);
				console.log(`left amount: ${o.leftAmount}`);
				assert.bnEqual(o.leftAmount, toUnit('50'));
				await usdt.approve(otc.address, toUnit('50'), { from: address1 });
				await otc.increaseAmount(toUnit('50'), { from: address1 });
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
					'Can not trade with self'
				);

				await assert.equal(await otc.hasOrder(address1), true);
				tx = await otc.makeDeal(address1, toUnit('50'), { from: address2 });
				for (const txLog of tx.logs) {
					console.log(`console.log event: ${txLog.event}`);
				}
				assert.eventsEqual(
					tx,
					'UpdateDeal',
					{ maker: address1, taker: address2, dealID: 0, dealState: 0 },
					'UpdateOrder',
					{ from: address1, orderID: 0, price: toUnit('6.33'), amount: toUnit('50') }
				);

				assert.equal(await otc.orderCount(), 1);
				assert.equal(await otc.dealCount(), 1);
				assert.equal(await otc.hasDeal(0), true);
				const dealInfo = await otc.deals(0);
				console.log(`deal info:
		\n\tid: ${dealInfo.dealID}
		\n\tprice: ${dealInfo.price}
		\n\tamount: ${dealInfo.amount}
		\n\tcollateral: ${dealInfo.collateral}
		\n\tcTime: ${dealInfo.cTime}
		\n\tuTime: ${dealInfo.uTime}
		\n\tmaker: ${dealInfo.maker}
		\n\ttaker: ${dealInfo.taker}
		\n\tdealState: ${dealInfo.dealState}
		\n\tcode: ${dealInfo.code}`);

				// check balance
				console.log(`address1 usdt balance: ${await usdt.balanceOf(address1)}`);
				console.log(`address2 dem balance: ${await synthetix.balanceOf(address2)}`);
			});

			it('check cancel deal', async () => {
				// cancel deal
				await assert.revert(otc.cancelDeal(1, { from: address2 }), 'Deal dose not exist!');
				await assert.revert(otc.cancelDeal(0, { from: address1 }), 'Only taker can cancel deal!');

				tx = await otc.cancelDeal(0, { from: address2 });
				assert.eventEqual(tx, 'UpdateDeal', {
					maker: address1,
					taker: address2,
					dealID: 0,
					dealState: 1,
				});

				await assert.revert(otc.confirmDeal(0, { from: address1 }), 'Deal should be confirming!');
			});

			it('check confirm deal', async () => {
				await assert.revert(otc.confirmDeal(1), 'Deal dose not exist!');
				await assert.revert(otc.confirmDeal(0, { from: address2 }), 'Only maker can confirm deal!');

				tx = await otc.confirmDeal(0, { from: address1 });
				assert.eventEqual(tx, 'UpdateDeal', {
					maker: address1,
					taker: address2,
					dealID: 0,
					dealState: 2,
				});

				const dealInfo = await otc.deals(0);
				console.log(`deal info:
		\n\tid: ${dealInfo.dealID}
		\n\tprice: ${dealInfo.price}
		\n\tamount: ${dealInfo.amount}
		\n\tcollateral: ${dealInfo.collateral}
		\n\tcTime: ${dealInfo.cTime}
		\n\tuTime: ${dealInfo.uTime}
		\n\tmaker: ${dealInfo.maker}
		\n\ttaker: ${dealInfo.taker}
		\n\tdealState: ${dealInfo.dealState}
		\n\tcode: ${dealInfo.code}`);
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
