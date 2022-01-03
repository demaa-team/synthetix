'use strict';

const { contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { currentTime, toUnit, fromUnit } = require('../utils')();

const { mockToken, setupAllContracts } = require('./setup');

const { toBytes32, fromBytes32 } = require('../..');

contract('OTC', async accounts => {
	let synthetix, usdt, otc, otcDao, exchangeRates, snxRate;

	const [, owner, oracle, , address1, address2, address3, treasuryWallet] = accounts;

	const [DEM] = ['DEM', 'sUSD'].map(toBytes32);

	// Run once at beginning - snapshots will take care of resetting this before each test
	before(async () => {
		// Mock sUSD as Depot only needs its ERC20 methods (System Pause will not work for suspending sUSD transfers)
		[{ token: usdt }] = await Promise.all([
			mockToken({ accounts, synth: 'USDT', name: 'Tether USD', symbol: 'USDT' }),
		]);

		({
			OTC: otc,
			OTCDao: otcDao,
			ExchangeRates: exchangeRates,
			Synthetix: synthetix,
		} = await setupAllContracts({
			accounts,
			mocks: {
				// mocks necessary for address resolver imports
				ERC20USDT: usdt,
			},
			contracts: ['OTC', 'OTCDao', 'AddressResolver', 'ExchangeRates', 'SystemStatus', 'Synthetix'],
		}));
	});

	addSnapshotBeforeRestoreAfterEach();

	const hash = toBytes32('0x01');

	const printBalance = async tag => {
		// check balance
		console.log(`address1 usdt balance ${tag}: ${fromUnit(await usdt.balanceOf(address1))}`);
		console.log(`address1 dem balance ${tag}: ${fromUnit(await synthetix.balanceOf(address1))}`);
		console.log(`address2 usdt balance ${tag}: ${fromUnit(await usdt.balanceOf(address2))}`);
		console.log(`address2 dem balance ${tag}: ${fromUnit(await synthetix.balanceOf(address2))}`);
		console.log(`otc usdt balance ${tag}: ${fromUnit(await usdt.balanceOf(otc.address))}`);
		console.log(`otc dem balance ${tag}: ${fromUnit(await synthetix.balanceOf(otc.address))}`);
		console.log(
			`treasuryWallet usdt balance ${tag}: ${fromUnit(await usdt.balanceOf(treasuryWallet))}`
		);
		console.log(
			`treasuryWallet dem balance ${tag}: ${fromUnit(await synthetix.balanceOf(treasuryWallet))}`
		);
	};

	const printOrderInfo = async tag => {
		const order = await otc.orders(address1);
		console.log(`Order after  ${tag}:
	order id: ${order.orderID}
	order coinCode: ${fromBytes32(order.coinCode)}
	order currencyCode: ${fromBytes32(order.currencyCode)}
	order price: ${fromUnit(order.price)}
	order leftAmount: ${fromUnit(order.leftAmount)}
	order lockedAmount: ${fromUnit(order.lockedAmount)}
	order cTime: ${order.cTime}
	order uTime: ${order.uTime}`);
	};

	const printDealInfo = async (tag, index) => {
		if (!index) {
			index = 0;
		}
		const dealInfo = await otc.deals(index);
		const dealCollateral = await otc.dealCollaterals(index);
		console.log(`deal info of deal ${tag}:
	id: ${dealInfo.dealID}
	orderID id: ${dealInfo.orderID}
	coinCode: ${fromBytes32(dealInfo.coinCode)}
	crrencyCode: ${fromBytes32(dealInfo.currencyCode)}
	price: ${fromUnit(dealInfo.price)}
	amount: ${fromUnit(dealInfo.amount)}
	fee: ${fromUnit(dealInfo.fee)}
	collateralType: ${fromBytes32(dealCollateral.collateralType)}
	collateral: ${fromUnit(dealCollateral.collateral)}
	lockedAmount: ${fromUnit(dealCollateral.lockedAmount)}
	cTime: ${dealInfo.cTime}
	uTime: ${dealInfo.uTime}
	maker: ${dealInfo.maker}
	taker: ${dealInfo.taker}
	dealState: ${dealInfo.dealState}`);
	};

	const prinstAdjudicationInfo = async tag => {
		const ad = await otcDao.adjudications(0);
		console.log(`Adjudication info ${tag}:
	id: ${ad.id}
	deal id: ${ad.dealID}
	plaintiff: ${ad.plaintiff}
	defendant: ${ad.defendant}
	adjudicator: ${ad.adjudicator}
	winner: ${ad.winner}
	evidence: ${ad.evidence}
	explanation: ${ad.explanation}
	verdict: ${ad.verdict}
	progress: ${ad.progress}
	cTime: ${ad.cTime}
	uTime: ${ad.uTime}
	`);
	};

	const printDaoUserInfo = async who => {
		const verifiedList = await otcDao.verifiedList(who);
		const count = await otcDao.violationCount(who);
		const inBlackList = await otcDao.blackList(who);
		console.log(`verified of ${who}
	verified: ${verifiedList.verified}
	usedNoCollateralCount: ${verifiedList.usedNoCollateralCount}
	violationCount: ${count}
	inBlackList: ${inBlackList}
		`);
	};

	const beforeTestDeal = (tag, needNoCollateral) => {
		beforeEach(async () => {
			await assert.equal(await otc.hasOrder(address1), true);

			// check balance
			console.log(
				`address2 dem balance before make deal: ${fromUnit(await synthetix.balanceOf(address2))}`
			);
			console.log(
				`otc dem allowance before make deal: ${fromUnit(
					await synthetix.allowance(address2, otc.address)
				)}`
			);

			if (needNoCollateral) {
				await otcDao.addToVerifyList(address2, { from: owner });
				console.log(`make deal without Collateral`);
			}

			// unhappy path: try make deal from address2 to address1
			await assert.revert(
				otc.makeDeal(address2, toUnit('100'), DEM, { from: address2 }),
				'Maker has no active order!'
			);
			await assert.revert(
				otc.makeDeal(address1, toUnit('1'), DEM, { from: address2 }),
				'Trade amount less than min!'
			);

			// happy path
			const tx = await otc.makeDeal(address1, toUnit('50'), DEM, { from: address2 });
			// check evnets
			for (const txLog of tx.logs) {
				console.log(`console.log event: ${txLog.event}`);
			}
			assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
				maker: address1,
				taker: address2,
				dealID: 0,
				dealState: 0,
			});
			console.log(
				`address2 balance of DEM after deal: ${fromUnit(await synthetix.balanceOf(address2))}`
			);

			// try to close order with pending deals
			await assert.revert(otc.closeOrder({ from: address3 }), 'Profile dose not exist!');
			await assert.revert(otc.closeOrder(), 'Profile dose not exist!');
			await assert.revert(otc.closeOrder({ from: address1 }), 'Has pending deals!');

			assert.equal(await otc.orderCount(), 1);
			assert.equal(await otc.dealCount(), 1);
			assert.equal(await otc.hasDeal(0), true);

			const dealInfo = await otc.deals(0);
			const dealCollateral = await otc.dealCollaterals(0);
			console.log(`deal info of deal 0:
							\tid: ${dealInfo.dealID}
							\tdeal id: ${dealInfo.orderID}
							\toinCode: ${fromBytes32(dealInfo.coinCode)}
							\turrencyCode: ${fromBytes32(dealInfo.currencyCode)}
							\tprice: ${fromUnit(dealInfo.price)}
							\tamount: ${fromUnit(dealInfo.amount)}
							\tfee: ${fromUnit(dealInfo.fee)}
							\tcollateralType: ${fromBytes32(dealCollateral.collateralType)}
							\tcollateral: ${fromUnit(dealCollateral.collateral)}
							\tlockedAmount: ${fromUnit(dealCollateral.lockedAmount)}
							\tcTime: ${dealInfo.cTime}
							\tuTime: ${dealInfo.uTime}
							\tmaker: ${dealInfo.maker}
							\ttaker: ${dealInfo.taker}
							\tdealState: ${dealInfo.dealState}`);

			const order = await otc.orders(address1);
			console.log(`order after maker deal :
							\torder id: ${order.orderID}
							\torder coinCode: ${fromBytes32(order.coinCode)}
							\torder currencyCode: ${fromBytes32(order.currencyCode)}
							\torder price: ${fromUnit(order.price)}
							\torder leftAmount: ${fromUnit(order.leftAmount)}
							\torder lockedAmount: ${fromUnit(order.lockedAmount)}
							\torder cTime: ${order.cTime}
							\torder uTime: ${order.uTime}
				`);

			// check balance
			console.log(
				`address2 dem balance after make deal: ${fromUnit(await synthetix.balanceOf(address2))}`
			);

			// uhappy path: try close order failed
			await assert.revert(otc.closeOrder({ from: address1 }), 'Has pending deals!');
		});
	};

	const testCancelDeal = tag => {
		it(`${tag}-check cancel deal`, async () => {
			// unhappy path: cancel deal failed
			await assert.revert(otc.cancelDeal(1, { from: address2 }), 'Deal dose not exist!');
			await assert.revert(otc.cancelDeal(0, { from: address1 }), 'Only taker can cancel deal!');

			// happy path
			let tx = await otc.cancelDeal(0, { from: address2 });
			assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
				maker: address1,
				taker: address2,
				dealID: 0,
				dealState: 1,
			});
			const order = await otc.orders(address1);
			console.log(`Order after deal canceled :
					order id: ${order.orderID}
					order coinCode: ${fromBytes32(order.coinCode)}
					order currencyCode: ${fromBytes32(order.currencyCode)}
					order price: ${fromUnit(order.price)}
					order leftAmount: ${fromUnit(order.leftAmount)}
					order lockedAmount: ${fromUnit(order.lockedAmount)}
					order cTime: ${order.cTime}
					order uTime: ${order.uTime}
				`);
			const dealInfo = await otc.deals(0);
			const dealCollateral = await otc.dealCollaterals(0);
			console.log(`deal info of deal 0 cancled:
							\tid: ${dealInfo.dealID}
							 deal id: ${dealInfo.orderID}
							\toinCode: ${fromBytes32(dealInfo.coinCode)}
							\turrencyCode: ${fromBytes32(dealInfo.currencyCode)}
							\tprice: ${fromUnit(dealInfo.price)}
							\tamount: ${fromUnit(dealInfo.amount)}
							\tfee: ${fromUnit(dealInfo.fee)}
							\tcollateralType: ${fromBytes32(dealCollateral.collateralType)}
							\tcollateral: ${fromUnit(dealCollateral.collateral)}
							\tlockedAmount: ${fromUnit(dealCollateral.lockedAmount)}
							\tcTime: ${dealInfo.cTime}
							\tuTime: ${dealInfo.uTime}
							\tmaker: ${dealInfo.maker}
							\ttaker: ${dealInfo.taker}
							\tdealState: ${dealInfo.dealState}`);
			console.log(
				`address2 balance of snx after deal 0 canceled: ${fromUnit(
					await synthetix.balanceOf(address2)
				)}`
			);

			// happy path: uable to confirm deal
			await assert.revert(otc.confirmDeal(0, { from: address1 }), 'Deal should be confirming!');

			// happy path: close order should success
			tx = await otc.closeOrder({ from: address1 });
			assert.eventEqual(tx, 'CloseOrder', { from: address1, orderID: 0 });
			assert.equal(await otc.hasOrder(address1), false);

			// check balance
			console.log(
				`address1 usdt balance after deal canceled: ${fromUnit(await usdt.balanceOf(address1))}`
			);
			console.log(
				`address2 dem balance after deal canceled: ${fromUnit(await synthetix.balanceOf(address2))}`
			);
			console.log(
				`otc usdt balance after deal canceled: ${fromUnit(await usdt.balanceOf(otc.address))}`
			);
			console.log(
				`otc dem balance after deal canceled: ${fromUnit(await usdt.balanceOf(otc.address))}`
			);
		});
	};

	const testConfirmDeal = tag => {
		it(`${tag}-check confirm deal`, async () => {
			// unhappy path: comfirm deal
			await assert.revert(otc.confirmDeal(1), 'Deal dose not exist!');
			await assert.revert(otc.confirmDeal(0, { from: address2 }), 'Only maker can confirm deal!');

			// check balance
			console.log(
				`address1 usdt balance before confirm deal: ${fromUnit(await usdt.balanceOf(address1))}`
			);
			console.log(
				`address2 dem balance before confirm deal: ${fromUnit(await synthetix.balanceOf(address2))}`
			);
			console.log(
				`otc dem balance before confirm deal: ${fromUnit(await synthetix.balanceOf(otc.address))}`
			);
			console.log(
				`otc usdt balance before confirm deal: ${fromUnit(await usdt.balanceOf(otc.address))}`
			);
			console.log(
				`treasuryWallet before  confirm deal: ${fromUnit(await usdt.balanceOf(treasuryWallet))}`
			);

			// happy path: confirm deal
			let tx = await otc.confirmDeal(0, { from: address1 });
			assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
				maker: address1,
				taker: address2,
				dealID: 0,
				dealState: 2,
			});
			const order = await otc.orders(address1);
			console.log(`Order after confirmed :
							\torder id: ${order.orderID}
							\torder coinCode: ${fromBytes32(order.coinCode)}
							\torder currencyCode: ${fromBytes32(order.currencyCode)}
							\torder price: ${fromUnit(order.price)}
							\torder leftAmount: ${fromUnit(order.leftAmount)}
							\torder lockedAmount: ${fromUnit(order.lockedAmount)}
							\torder cTime: ${order.cTime}
							\torder uTime: ${order.uTime}
							`);
			const dealInfo = await otc.deals(0);
			const dealCollateral = await otc.dealCollaterals(0);
			console.log(`deal info of deal 0 confirmed:
							\tid: ${dealInfo.dealID}
							\tdeal id: ${dealInfo.orderID}
							\toinCode: ${fromBytes32(dealInfo.coinCode)}
							\turrencyCode: ${fromBytes32(dealInfo.currencyCode)}
							\tprice: ${fromUnit(dealInfo.price)}
							\tamount: ${fromUnit(dealInfo.amount)}
							\tfee: ${fromUnit(dealInfo.fee)}
							\tcollateralType: ${fromBytes32(dealCollateral.collateralType)}
							\tcollateral: ${fromUnit(dealCollateral.collateral)}
							\tlockedAmount: ${fromUnit(dealCollateral.lockedAmount)}
							\tcTime: ${dealInfo.cTime}
							\tuTime: ${dealInfo.uTime}
							\tmaker: ${dealInfo.maker}
							\ttaker: ${dealInfo.taker}
							\tdealState: ${dealInfo.dealState}`);

			// check balance
			console.log(
				`address1 usdt balance after confirm deal: ${fromUnit(await usdt.balanceOf(address1))}`
			);
			console.log(
				`address2 dem balance after confirm deal: ${fromUnit(await synthetix.balanceOf(address2))}`
			);
			console.log(
				`otc dem balance after confirm deal: ${fromUnit(await synthetix.balanceOf(otc.address))}`
			);
			console.log(
				`otc usdt balance after confirm deal: ${fromUnit(await usdt.balanceOf(otc.address))}`
			);
			console.log(
				`treasuryWallet balance after confirm deal: ${fromUnit(
					await usdt.balanceOf(treasuryWallet)
				)}`
			);

			// happy path: try close order
			tx = await otc.closeOrder({ from: address1 });
			assert.eventEqual(tx, 'CloseOrder', { from: address1, orderID: 0 });

			// check redeemCollateral after deal confirm
			await assert.revert(otc.redeemCollateral(1, { from: address1 }), 'Deal dose not exist!');
			await assert.revert(
				otc.redeemCollateral(0, { from: address1 }),
				'Only taker can redeem collateral'
			);
			await assert.revert(otc.redeemCollateral(0, { from: address2 }), 'No collateral trans back!');
			// console.log(`remainning frozen perod: ${fromUnit(await otc.leftFrozenTime(0))}`);
			// tx = await otc.setDealFrozenPeriod(0, { from: owner });
			// await otc.redeemCollateral(0, { from: address2 });
			console.log(`address2 balance of snx: ${fromUnit(await synthetix.balanceOf(address2))}`);
		});
	};

	const testExceedMaxNoCollateralLimit = tag => {
		it(`${tag}-check make deal time limt when verified`, async () => {
			await otc.setMinTradeAmount(toUnit('10'), { from: owner });
			await otcDao.setMaxNoCollateralTradeCount(1, { from: owner });

			let tx = await otc.confirmDeal(0, { from: address1 });
			assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
				maker: address1,
				taker: address2,
				dealID: 0,
				dealState: 2,
			});

			// check balance
			let tag = 'before make deal the second time';
			await printOrderInfo(tag);
			await printDealInfo(tag);
			await printBalance(tag);
			await printDaoUserInfo(address1);
			await printDaoUserInfo(address2);

			// happy path: confirm deal
			tx = await otc.makeDeal(address1, toUnit('10'), DEM, { from: address2 });
			assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
				maker: address1,
				taker: address2,
				dealID: 1,
				dealState: 0,
			});
			tag = 'after make deal the second time';
			await printOrderInfo(tag);
			await printDealInfo(tag, 1);
			await printBalance(tag);
			await printDaoUserInfo(address1);
			await printDaoUserInfo(address2);
			tx = await otc.confirmDeal(1, { from: address1 });
			assert.eventsEqual(tx, 'UpdateOrder', { from: address1, orderID: 0 }, 'UpdateDeal', {
				maker: address1,
				taker: address2,
				dealID: 1,
				dealState: 2,
			});
			tag = 'after confirm deal the second time';
			await printOrderInfo(tag);
			await printDealInfo(tag, 1);
			await printBalance(tag);
			await printDaoUserInfo(address1);
			await printDaoUserInfo(address2);
		});
	};

	before(async () => {
		const timestamp = await currentTime();

		// add underlying assets
		assert.equal(await otc.underlyingAssetsCount(), 0);
		await otc.addAsset([toBytes32('USDT')], [usdt.address], { from: owner });
		assert.equal(await otc.underlyingAssetsCount(), 1);
		await otc.removeAsset(toBytes32('USDT'), { from: owner });
		assert.equal(await otc.underlyingAssetsCount(), 0);
		await otc.addAsset([toBytes32('USDT'), toBytes32('DEM')], [usdt.address, synthetix.address], {
			from: owner,
		});
		assert.equal(await otc.underlyingAssetsCount(), 2);

		snxRate = toUnit('8');

		await exchangeRates.updateRates([DEM], [snxRate], timestamp, {
			from: oracle,
		});

		// set setTreasuryWallet
		await otc.setTreasuryWallet(treasuryWallet, { from: owner });
		console.log(`treasuryWallet: ${await otc.treasuryWallet()}`);

		const tx = await otc.registerProfile(hash, { from: address1 });
		assert.eventEqual(tx, 'RegisterProfile', { from: address1, ipfsHash: hash });
	});

	it('check initial state', async () => {
		// check taker and maker ratio
		assert.bnEqual(await otc.takerCRatio(), toUnit('0.2'));
		assert.bnEqual(await otc.makerCRatio(), toUnit('0.2'));
		// check fee ratio
		assert.bnEqual(await otc.feeRatio(), toUnit('0.003'));
		// check minTradeAmount
		assert.bnEqual(await otc.minTradeAmount(), toUnit('50'));
		// check maxTradeAmountForVerified
		assert.bnEqual(await otc.maxTradeAmountForVerified(), toUnit('1000'));

		assert.equal(await otc.isResolverCached(), true);
		const expectDeps = ['Synthetix', 'ExchangeRates', 'OTCDao'];
		const deps = await otc.resolverAddressesRequired();
		for (const dep of deps) {
			assert.equal(expectDeps.includes(web3.utils.hexToString(dep)), true);
		}
	});

	describe('check profile and order', () => {
		let result;

		before(async () => {
			result = await otc.profiles(address1);
			assert.equal(result.ipfsHash, hash);
			console.log(
				`address hash: ${result.ipfsHash}\n-- create time ${result.cTime}\n-- update time ${result.uTime}`
			);
		});

		it('check reigster functions', async () => {
			assert.equal(await otc.hasProfile(address1), true);
			assert.equal(await otc.hasProfile(address2), false);

			result = await otc.profiles(address2);
			console.log(
				`address2 hash: ${result.ipfsHash}\n-- create time ${result.cTime}\n-- update time ${result.uTime}`
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
			before(async () => {
				// await otc.openOrder(0, toUnit('6.33'), toUnit('100'), {from:address1});
				console.log(`balanceof: ${await usdt.balanceOf(owner)}`);
				console.log(`totalSupply: ${await usdt.totalSupply()}`);

				// 1 seller approve otc to trans asset
				await usdt.transfer(address1, toUnit('1000'), { from: owner });
				console.log(
					`usdt balanceof address1 before open order: ${fromUnit(await usdt.balanceOf(address1))}`
				);
				await usdt.approve(otc.address, toUnit('100'), { from: address1 });

				// set buyer using DEM as collate
				await synthetix.transfer(address2, toUnit('10000'), { from: owner });
				console.log(
					`address2 balance of DEM before make deal: ${fromUnit(
						await synthetix.balanceOf(address2)
					)}`
				);
				await synthetix.approve(otc.address, await synthetix.balanceOf(address2), {
					from: address2,
				});

				// 2 open order
				const tx = await otc.openOrder(
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
				let order = await otc.orders(address1);
				console.log(`order info for addres1 ${address1} :
					order id: ${order.orderID}
					order coinCode: ${fromBytes32(order.coinCode)}
					order currencyCode: ${fromBytes32(order.currencyCode)}
					order price: ${fromUnit(order.price)}
					order leftAmount: ${fromUnit(order.leftAmount)}
					order lockedAmount: ${fromUnit(order.lockedAmount)}
					order cTime: ${order.cTime}
					order uTime: ${order.uTime}
					`);
				console.log(
					`usdt balanceof address1 after open order: ${fromUnit(await usdt.balanceOf(address1))}`
				);
				console.log(
					`usdt balanceof otc after open order: ${fromUnit(await usdt.balanceOf(otc.address))}`
				);

				// Unhappyt path: can't decrease amount
				await assert.revert(
					otc.decreaseAmount(toUnit('0'), { from: address1 }),
					'Decrease amount should gt than 0!'
				);
				await assert.revert(
					otc.decreaseAmount(toUnit('101'), { from: address1 }),
					'Left amount is insufficient!'
				);
				await assert.revert(otc.decreaseAmount(toUnit('50')), 'Order dose not exist!');

				// decrese 50 from order left
				await otc.decreaseAmount(toUnit('50'), { from: address1 });
				console.log(
					`usdt balanceof address1 after decrease 50: ${fromUnit(await usdt.balanceOf(address1))}`
				);
				order = await otc.orders(address1);
				console.log(`order left amount after decrease 50 : ${fromUnit(order.leftAmount)}`);

				// increse order amount
				await usdt.approve(otc.address, toUnit('50'), { from: address1 });
				await otc.increaseAmount(toUnit('50'), { from: address1 });
				console.log(
					`usdt balanceof address1 after increase 50: ${fromUnit(await usdt.balanceOf(address1))}`
				);
				order = await otc.orders(address1);
				console.log(`order left amount address1 after increase 50: ${fromUnit(order.leftAmount)}`);
			});

			describe('Try make deal with collateral', () => {
				const tag = '[Use collateral]';
				beforeTestDeal(tag);
				testCancelDeal(tag);
				testConfirmDeal(tag);
			});

			describe('Make deal without Collateral', () => {
				beforeEach(async () => {
					const tx = await otcDao.addToVerifyList(address2, { from: owner });
					await assert.eventEqual(tx, 'UpdateVerifiedList', {
						from: owner,
						who: address2,
						action: 0,
					});
					const v = await otcDao.verifiedList(address2);
					console.log(
						`address2 verify info: verified: ${v.verified} - use count: ${v.usedNoCollateralCount}`
					);
				});

				const tag = '[No collateral]';
				beforeTestDeal(tag);
				testCancelDeal(tag);
				testConfirmDeal(tag);
				testExceedMaxNoCollateralLimit(tag);
			});

			describe('Test adjudications', () => {
				describe('seller apply adjudications with Collateral', () => {
					const tag = '[Adjudication]';
					beforeTestDeal(tag);

					it('test unhappy path', async () => {
						await assert.revert(
							otc.adjudicateDeal(0, address2, toUnit('1')),
							'Only OTC DAO contract can adjudicate deal!'
						);
					});

					beforeEach(async () => {
						console.log(`address1: ${address1}
						address2: ${address2}`);
						console.log(`CompensationRatio:
						selfCompensationRatio: ${fromUnit(await otcDao.selfCompensationRatio())}
						daoCompensationRatio: ${fromUnit(await otcDao.daoCompensationRatio())}`);
						await assert.revert(
							otcDao.applyAdjudication(1, 'seller dose not trans cache!'),
							'Deal not exists!'
						);
						await assert.revert(
							otcDao.applyAdjudication(0, 'seller dose not trans cache!'),
							'Deal is not expired!'
						);

						await otc.setDealExpiredPeriod(0, { from: owner });
						console.log(`setDealExpiredPeriod result ${await otc.dealExpiredPeriod()}`);
						await assert.revert(
							otcDao.applyAdjudication(0, 'seller dose not trans cache!'),
							'Invalid plaintiff!'
						);
						await otcDao.applyAdjudication(0, 'seller dose not trans cache!', { from: address1 });
						prinstAdjudicationInfo('applyAdjudication');
					});

					it('test buyer dose not respond', async () => {
						// check balance
						await printBalance('before adjudicate');

						// awit otcDao.
						await assert.revert(
							otcDao.adjudicate(0, address1, ''),
							'RespondExpiredPeriod is valid!'
						);
						await otcDao.setRespondExpiredPeriod(0, { from: owner });
						console.log(`ExpiredPeriod: ${await otcDao.respondExpiredPeriod()}`);
						console.log(`DealExpiredPeriod result ${await otc.dealExpiredPeriod()}`);

						await otcDao.adjudicate(0, address1, '');

						await prinstAdjudicationInfo('adjudicate');
						await printOrderInfo('after adjudicate');
						await printDealInfo('after adjudicate');
						await printBalance('after adjudicate');
						await printDaoUserInfo(address1);
						await printDaoUserInfo(address2);
					});

					it('test buyer respond and the maker is the winner', async () => {
						// check balance
						await printBalance('before adjudicate');

						await assert.revert(
							otcDao.respondAdjudication(1, 'has payed'),
							'Adjudication not exist!'
						);
						await assert.revert(
							otcDao.respondAdjudication(0, 'has payed'),
							'Only defendant can respond!'
						);

						await otcDao.respondAdjudication(0, 'has payed', { from: address2 });

						// awit otcDao.
						await otcDao.setRespondExpiredPeriod(0, { from: owner });

						await otcDao.adjudicate(0, address1, 'evidence is invalid', { from: owner });

						await prinstAdjudicationInfo('adjudicate');
						await printOrderInfo('after adjudicate');
						await printDealInfo('after adjudicate');
						await printBalance('after adjudicate');
						await printDaoUserInfo(address1);
						await printDaoUserInfo(address2);
					});

					it('test buyer respond and the taker is the winner', async () => {
						// check balance
						await printBalance('before adjudicate');

						await assert.revert(
							otcDao.respondAdjudication(1, 'has payed'),
							'Adjudication not exist!'
						);
						await assert.revert(
							otcDao.respondAdjudication(0, 'has payed'),
							'Only defendant can respond!'
						);

						await otcDao.respondAdjudication(0, 'has payed', { from: address2 });

						// awit otcDao.
						await otcDao.setRespondExpiredPeriod(0, { from: owner });

						await otcDao.adjudicate(0, address2, 'evidence is invalid', { from: owner });

						await prinstAdjudicationInfo('adjudicate');
						await printOrderInfo('after adjudicate');
						await printDealInfo('after adjudicate');
						await printBalance('after adjudicate');
						await printDaoUserInfo(address1);
						await printDaoUserInfo(address2);
					});
				});

				describe('seller apply adjudications with no collateral', () => {
					const tag = '[Adjudication]';
					beforeTestDeal(tag, true);

					beforeEach(async () => {
						// add buyer to verifyed list
						await assert.revert(
							otcDao.addToVerifyList(address2),
							'Only the contract owner may perform this action'
						);
						await otcDao.addToVerifyList(address2, { from: owner });

						await otc.setDealExpiredPeriod(0, { from: owner });
						console.log(`setDealExpiredPeriod result ${await otc.dealExpiredPeriod()}`);
						await assert.revert(
							otcDao.applyAdjudication(0, 'seller dose not trans cache!'),
							'Invalid plaintiff!'
						);
						await otcDao.applyAdjudication(0, 'seller dose not trans cache!', { from: address1 });

						prinstAdjudicationInfo('applyAdjudication');
					});

					it('test buyer dose not respond', async () => {
						// check balance
						await printBalance('before adjudicate');

						// awit otcDao.
						await assert.revert(
							otcDao.adjudicate(0, address1, ''),
							'RespondExpiredPeriod is valid!'
						);
						await otcDao.setRespondExpiredPeriod(0, { from: owner });
						console.log(`ExpiredPeriod: ${await otcDao.respondExpiredPeriod()}`);
						console.log(`DealExpiredPeriod result ${await otc.dealExpiredPeriod()}`);

						console.log(`======taker col state=== ${await otcDao.needCollateral(address2)}`);
						const tx = await otcDao.adjudicate(0, address1, '', { from: address1 });

						for (const txLog of tx.logs) {
							console.log(`console.log applyAdjudication event: ${txLog.event}`);
						}
						await assert.eventsEqual(
							tx,
							'UpdateBlackList',
							{ from: otc.address, who: address2, action: 0 },
							'UpdateViolationCount',
							{ from: address1, who: address2 },
							'UpdateAdjudication',
							{ from: address1, adjudicationID: 0 }
						);

						await prinstAdjudicationInfo('adjudicate');
						await printOrderInfo('after adjudicate');
						await printDealInfo('after adjudicate');
						await printBalance('after adjudicate');
						await printDaoUserInfo(address1);
						await printDaoUserInfo(address2);
					});

					it('test buyer respond and the maker is the winner', async () => {
						// check balance
						await printBalance('before adjudicate');

						await assert.revert(
							otcDao.respondAdjudication(1, 'has payed'),
							'Adjudication not exist!'
						);
						await assert.revert(
							otcDao.respondAdjudication(0, 'has payed'),
							'Only defendant can respond!'
						);

						await otcDao.respondAdjudication(0, 'has payed', { from: address2 });

						// awit otcDao.
						await otcDao.setRespondExpiredPeriod(0, { from: owner });

						await otcDao.adjudicate(0, address1, 'evidence is invalid', { from: owner });

						await prinstAdjudicationInfo('adjudicate');
						await printOrderInfo('after adjudicate');
						await printDealInfo('after adjudicate');
						await printBalance('after adjudicate');
						await printDaoUserInfo(address1);
						await printDaoUserInfo(address2);
					});

					it('test buyer respond and the taker is the winner', async () => {
						// check balance
						await printBalance('before adjudicate');

						await assert.revert(
							otcDao.respondAdjudication(1, 'has payed'),
							'Adjudication not exist!'
						);
						await assert.revert(
							otcDao.respondAdjudication(0, 'has payed'),
							'Only defendant can respond!'
						);

						await otcDao.respondAdjudication(0, 'has payed', { from: address2 });

						// awit otcDao.
						await otcDao.setRespondExpiredPeriod(0, { from: owner });

						await otcDao.adjudicate(0, address2, 'evidence is invalid', { from: owner });

						await prinstAdjudicationInfo('adjudicate');
						await printOrderInfo('after adjudicate');
						await printDealInfo('after adjudicate');
						await printBalance('after adjudicate');
						await printDaoUserInfo(address1);
						await printDaoUserInfo(address2);
					});
				});

				describe('taker in black list', () => {
					it('taker is black list', async () => {
						await otcDao.addToVerifyList(address2, { from: owner });
						const tx = await otcDao.addToBlackList(address2, { from: owner });
						await assert.eventEqual(tx, 'UpdateBlackList', {
							from: owner,
							who: address2,
							action: 0,
						});
						await assert.revert(
							otc.makeDeal(address1, toUnit('50'), DEM, { from: address2 }),
							'Taker is disallowed for tradding!'
						);
					});
				});
			});
		}); // end describle check  order
	}); // end describle check profile and order
});
