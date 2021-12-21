'use strict';

const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const { gray } = require('chalk');

const { loadCompiledFiles } = require('../solidity');
const Deployer = require('../Deployer');
const { defaults } = require('../../..');

const {
	constants: { CONFIG_FILENAME, DEPLOYMENT_FILENAME, BUILD_FOLDER },
	wrap,
} = require('../../..');

const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
} = require('../util');
const { performTransactionalStep } = require('../command-utils/transact');

const DEFAULTS = {
	buildPath: path.join(__dirname, '..', '..', '..', BUILD_FOLDER),
	priorityGasPrice: '1',
};

const addOTCAssets = async ({
	network,
	buildPath = DEFAULTS.buildPath,
	deploymentPath,
	maxFeePerGas,
	maxPriorityFeePerGas = DEFAULTS.priorityGasPrice,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network });
	ensureDeploymentPath(deploymentPath);

	console.log(`build path ${network} - ${buildPath} - ${deploymentPath}`);
	const { getTarget } = wrap({ network, fs, path });

	const { configFile, deployment, deploymentFile } = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	const { providerUrl, privateKey: envPrivateKey, explorerLinkPrefix } = loadConnections({
		network,
	});

	// allow local deployments to use the private key passed as a CLI option
	let privateKey;
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	console.log(gray('Loading the compiled contracts locally...'));
	const { compiled } = loadCompiledFiles({ buildPath });

	const deployer = new Deployer({
		compiled,
		config: {},
		configFile,
		deployment,
		deploymentFile,
		maxFeePerGas,
		maxPriorityFeePerGas,
		network,
		privateKey,
		providerUrl,
		dryRun: false,
	});

	// TODO - this should be fixed in Deployer
	deployer.deployedContracts.SafeDecimalMath = {
		address: getTarget({ contract: 'SafeDecimalMath' }).address,
	};

	const { account, signer } = deployer;
	const provider = deployer.provider;

	console.log(gray(`Using account with public key ${account}`));
	console.log(gray(`Using max base fee of ${maxFeePerGas} GWEI`));

	const currentGasPrice = await provider.getGasPrice();
	console.log(
		gray(`Current gas price is approx: ${ethers.utils.formatUnits(currentGasPrice, 'gwei')} GWEI`)
	);

	const { address: otcAddress, source } = deployment.targets['OTC'];
	const { abi: otcABI } = deployment.sources[source];
	const otc = new ethers.Contract(otcAddress, otcABI, provider);

	if (otc) {
		console.log(`otc address: ${otc.address}`);
	}

	const runStep = async opts =>
		performTransactionalStep({
			...opts,
			deployer,
			signer,
			explorerLinkPrefix,
		});

	const assetKeys = [];
	const addresses = [];
	for (const asset of defaults.OTC_ASSETS[network]) {
		assetKeys.push(asset[0]);
		addresses.push(asset[1]);
	}
	console.log(`${assetKeys} - ${addresses}`);

	await runStep({
		contract: 'OTC',
		target: otc,
		//   read: 'underlyingAssetsCount',
		//  expected: input => input === addressOf(ProxyERC20),
		write: 'addAsset',
		writeArg: [assetKeys, addresses],
		comment: 'Ensure the assets added to otc',
	});
};

module.exports = {
	addOTCAssets,
	cmd: program =>
		program
			.command('add-otc-assets')
			.description('Add assets to OTC')
			.option(
				'-b, --build-path [value]',
				'Path to a folder hosting compiled files from the "build" step in this script',
				path.join(__dirname, '..', '..', '..', BUILD_FOLDER)
			)
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file ${CONFIG_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option('-g, --max-fee-per-gas <value>', 'Maximum base gas fee price in GWEI')
			.option(
				'--max-priority-fee-per-gas <value>',
				'Priority gas fee price in GWEI',
				DEFAULTS.priorityGasPrice
			)
			.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'mumbai')
			.action(addOTCAssets),
};
