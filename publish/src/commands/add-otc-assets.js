'use strict';

const path = require('path');
const { gray} = require('chalk');
const Deployer = require('../Deployer');
const NonceManager = require('../NonceManager');
const { loadCompiledFiles} = require('../solidity');
const Web3 = require('web3');

const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
	performTransactionalStep,
} = require('../util');

const {
	constants: {
		BUILD_FOLDER,
		DEPLOYMENT_FILENAME,
	},
	defaults,
} = require('../../../.');

const DEFAULTS = {
	gasPrice: '2',
	methodCallGasLimit: 1e6, // 250k
	contractDeploymentGasLimit: 2e7, // TODO split out into seperate limits for different contracts, Proxys, Synths, Synthetix
	network: 'mumbai',
	buildPath: path.join(__dirname, '..', '..', '..', BUILD_FOLDER),
	rewardsToDeploy: [],
};


const addOTCAssets = async ({
	gasPrice = DEFAULTS.gasPrice,
	methodCallGasLimit = DEFAULTS.methodCallGasLimit,
	contractDeploymentGasLimit = DEFAULTS.contractDeploymentGasLimit,
	network = DEFAULTS.network,
	buildPath = DEFAULTS.buildPath,
	deploymentPath,
	privateKey
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network });
	ensureDeploymentPath(deploymentPath);

	const {
		ownerActions,
		ownerActionsFile,
		deployment,
		deploymentFile,
	} = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	console.log(gray('Loading the compiled contracts locally...'));
	const {compiled } = loadCompiledFiles({ buildPath });

	const { providerUrl, privateKey: envPrivateKey, etherscanLinkPrefix } = loadConnections({
		network,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	const deployer = new Deployer({
		compiled,
		contractDeploymentGasLimit,
		config:{},
		configFile: null, // null configFile so it doesn't overwrite config.json
		deployment,
		deploymentFile,
		gasPrice,
		methodCallGasLimit,
		network,
		privateKey,
		providerUrl
	});

	const { account } = deployer;

	const nonceManager = new NonceManager({});
	const manageNonces = deployer.manageNonces;

	const runStep = async opts =>
	performTransactionalStep({
		gasLimit: methodCallGasLimit, // allow overriding of gasLimit
		...opts,
		deployer,
		gasPrice,
		etherscanLinkPrefix,
		ownerActions,
		ownerActionsFile,
		nonceManager: manageNonces ? nonceManager : undefined,
	});

	const assetKeys = [];
	const addresses = [];
	for (const asset of defaults.OTC_ASSETS[network]) {
		assetKeys.push(asset[0]);
		addresses.push(asset[1]);
	}
	console.log(`${assetKeys} - ${addresses}`);
	const web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));
	web3.eth.accounts.wallet.add(privateKey);
	const otc = new web3.eth.Contract(
		deployment.sources['OTC'].abi,
		deployment.targets['OTC'].address
	);
	// Rebuild the cache so it knows about CollateralShort
	await runStep({
		account,
		gasLimit: 6e6,
		contract: 'OTC',
		target: otc,
		write: 'addAsset',
		writeArg: [assetKeys, addresses],
	});
};

module.exports = {
	addOTCAssets,
	DEFAULTS,
	cmd: program =>
		program
			.command('add-otc-assets')
			.description('Add assets to OTC')
			.option(
				'-b, --build-path [value]',
				'Path to a folder hosting compiled files from the "build" step in this script',
				DEFAULTS.buildPath
			)
			.option(
				'-c, --contract-deployment-gas-limit <value>',
				'Contract deployment gas limit',
				parseInt,
				DEFAULTS.contractDeploymentGasLimit
			)
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has the rewards file and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option('-g, --gas-price <value>', 'Gas price in GWEI', DEFAULTS.gasPrice)
			.option(
				'-m, --method-call-gas-limit <value>',
				'Method call gas limit',
				parseInt,
				DEFAULTS.methodCallGasLimit
			)
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-v, --private-key [value]',
				'The private key to deploy with (only works in local mode, otherwise set in .env).'
			)
			.action(addOTCAssets),
};
