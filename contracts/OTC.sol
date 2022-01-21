pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IOTC.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IOTCDao.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/ISynthetix.sol";

contract OTC is MixinResolver, IOTC, Owned {
    /* ========== LIBRARIES ========== */
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    struct Deal {
        // underlying asset key
        bytes32 coinCode;
        // trade partener code
        bytes32 currencyCode;
        // a increasement number for 0
        uint256 dealID;
        // order id
        uint256 orderID;
        // deal price
        uint256 price;
        // deal amount
        uint256 amount;
        // fees charged from taker
        uint256 fee;
        // time when deal created or updated
        uint256 cTime;
        uint256 uTime;
        // record maker and taker
        address maker;
        address taker;
        // deal state
        DealState dealState;
    }

    struct DealCollateral {
        // collateral type ETH/USDT/
        bytes32 collateralType;
        // locked amount
        uint256 lockedAmount;
        // collateral for make this deal
        uint256 collateral;
    }

    // User profile
    struct Profile {
        // Hash point to the address in ipfs where user profile sotred
        string ipfsHash;
        // timestapm when order created
        uint256 cTime;
        uint256 uTime;
    }

    struct Order {
        // exange coin
        bytes32 coinCode;
        // trade partener code
        bytes32 currencyCode;
        // uinique order id
        uint256 orderID;
        // Price of order
        uint256 price;
        // Left usdt amount not been selled
        uint256 leftAmount;
        // locked amount
        uint256 lockedAmount;
        // timestapm when order created
        uint256 cTime;
        uint256 uTime;
    }

    // profile table
    mapping(address => Profile) public profiles;
    // order table
    mapping(address => Order) public orders;
    // deal table
    mapping(uint256 => Deal) public deals;
    // deal Collateral info
    mapping(uint256 => DealCollateral) public dealCollaterals;
    // underlying assetst for otc supported
    mapping(bytes32 => IERC20) public underlyingAssets;
    uint256 public underlyingAssetsCount;
    // count users
    uint256 public userCount;
    // an incresement number used for generating order id
    uint256 public orderCount;
    // an incresement number used for generating deal id
    uint256 public dealCount;
    // collater forzen period before taker redeem collateral
    // only have valid vaule when has reward schdule
    uint256 public dealFrozenPeriod;
    // collateral ration 20%
    uint256 public takerCRatio = 200000000000000000;
    uint256 public makerCRatio = 200000000000000000;
    // fee ratio charged on taker, normal 0.3%
    uint256 public feeRatio = 0.003 ether;
    uint256 public minTradeAmount = 50 * 1e18;
    uint256 public maxTradeAmountForVerified = 1000 * 1e18;
    // deal expired period before confimred
    uint256 public dealExpiredPeriod = 1 hours;
    // fee pool wallet
    address payable public treasuryWallet;

    bytes32 private constant DEM = "DEM";
    bytes32 private constant dUSD = "dUSD";
    bytes32 private constant USDT = "USDT";
    bytes32 private constant CONTRACT_SYNTHETIX = "Synthetix";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_OTCDao = "OTCDao";

    constructor(address _owner, address _resolver) public Owned(_owner) MixinResolver(_resolver) {}

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        addresses = new bytes32[](3);
        addresses[0] = CONTRACT_SYNTHETIX;
        addresses[1] = CONTRACT_EXRATES;
        addresses[2] = CONTRACT_OTCDao;
    }

    function synthetix() internal view returns (ISynthetix) {
        return ISynthetix(requireAndGetAddress(CONTRACT_SYNTHETIX));
    }

    function synthetixERC20() internal view returns (IERC20) {
        return IERC20(requireAndGetAddress(CONTRACT_SYNTHETIX));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXRATES));
    }

    function otcDao() internal view returns (IOTCDao) {
        return IOTCDao(requireAndGetAddress(CONTRACT_OTCDao));
    }

    function erc20(bytes32 coinCode) public view returns (IERC20) {
        IERC20 asset = underlyingAssets[coinCode];
        require(address(0) != address(asset), "Invalid underlying asset!");
        return IERC20(asset);
    }

    function setTreasuryWallet(address payable _treasuryWallet) public onlyOwner {
        require(address(0) != _treasuryWallet, "Invalid treasury wallet address!");
        treasuryWallet = _treasuryWallet;
    }

    function addAsset(bytes32[] memory coinCodes, IERC20[] memory contracts) public onlyOwner {
        require(coinCodes.length == contracts.length, "Should have the same length!");
        for (uint256 i = 0; i < coinCodes.length; i++) {
            require(contracts[i] != IERC20(address(0)), "Invalid contract address!");
            underlyingAssets[coinCodes[i]] = contracts[i];
        }
        underlyingAssetsCount = coinCodes.length;
    }

    function removeAsset(bytes32 coinCode) public onlyOwner {
        delete underlyingAssets[coinCode];
        underlyingAssetsCount--;
    }

    function setTakerCRatio(uint256 cRatio) public onlyOwner {
        takerCRatio = cRatio;
    }

    function setMakerCRatio(uint256 cRatio) public onlyOwner {
        makerCRatio = cRatio;
    }

    function setMinTradeAmount(uint256 minAmount) public onlyOwner {
        minTradeAmount = minAmount;
    }

    function setDealFrozenPeriod(uint256 period) public onlyOwner {
        dealFrozenPeriod = period;
    }

    function setMaxTradeAmountForVerified(uint256 amount) public onlyOwner {
        maxTradeAmountForVerified = amount;
    }

    function setFeeRatio(uint256 ratio) public onlyOwner {
        feeRatio = ratio;
    }

    function setDealExpiredPeriod(uint256 period) public onlyOwner {
        dealExpiredPeriod = period;
    }

    function getDealInfo(uint256 dealID)
        public
        view
        dealExist(dealID)
        returns (
            bool,
            address,
            address
        )
    {
        return (true, deals[dealID].maker, deals[dealID].taker);
    }

    function isDealExpired(uint256 dealID) public view dealExist(dealID) returns (bool) {
        return ((deals[dealID].uTime + dealExpiredPeriod) <= block.timestamp);
    }

    function isDealClosed(uint256 dealID) public view dealExist(dealID) returns (bool) {
        return (deals[dealID].dealState != DealState.Confirming);
    }

    // Personal profile
    function registerProfile(string memory ipfsHash) public {
        require(!hasProfile(msg.sender), "Profile exist!");

        profiles[msg.sender] = Profile({ipfsHash: ipfsHash, cTime: block.timestamp, uTime: block.timestamp});

        emit RegisterProfile(msg.sender, ipfsHash);

        userCount++;
    }

    function destroyProfile() public profileExist() {
        delete profiles[msg.sender];

        emit DestroyProfile(msg.sender);

        userCount--;
    }

    function updateProfile(string memory ipfsHash) public profileExist() {
        profiles[msg.sender].ipfsHash = ipfsHash;
        profiles[msg.sender].uTime = block.timestamp;

        emit UpdateProfile(msg.sender, ipfsHash);
    }

    function hasProfile(address user) public view returns (bool) {
        return profiles[user].cTime > 0;
    }

    function getProfileHash(address user) external view profileExist() returns (string memory ipfsHash) {
        return profiles[user].ipfsHash;
    }

    function getUserCount() public view returns (uint256) {
        return userCount;
    }

    function migrate(bytes32[] memory assetKeys, address newOTC) public onlyOwner {
        revert("Not implemet!");
    }

    function maxExchangeableAsset(address maker) public view orderExist(maker) returns (uint256) {
        return exchangeableAsset(orders[maker].leftAmount, makerCRatio);
    }

    function exchangeableAsset(uint256 amount, uint256 ratio) public pure returns (uint256) {
        // exchangeable = amount /(1 + ratio)
        return amount.divideDecimalRound(SafeDecimalMath.unit().add(ratio));
    }

    function lockedAsset(uint256 amount, uint256 ratio) public pure returns (uint256) {
        // locked = amount * ratio
        return amount.multiplyDecimalRound(ratio);
    }

    function tradeFee(uint256 amount) public view returns (uint256) {
        return amount.multiplyDecimalRound(feeRatio);
    }

    // Order
    function openOrder(
        bytes32 coinCode,
        bytes32 currencyCode,
        uint256 price,
        uint256 amount
    ) public {
        require(hasProfile(msg.sender), "Profile dose not exist!");
        require(!hasOrder(msg.sender), "Order has exist!");
        require(!otcDao().isInBlackList(msg.sender), "User is in the blacklist!");

        IERC20 asset = erc20(coinCode);

        // delegate token to this
        asset.transferFrom(msg.sender, address(this), amount);

        // create order
        orders[msg.sender] = Order({
            coinCode: coinCode,
            currencyCode: currencyCode,
            orderID: orderCount,
            price: price,
            leftAmount: amount,
            lockedAmount: uint256(0),
            cTime: block.timestamp,
            uTime: block.timestamp
        });

        emit OpenOrder(msg.sender, orderCount);

        orderCount++;
    }

    function closeOrder() public profileExist() orderExist(msg.sender) {
        // check if has pending deal
        Order storage order = orders[msg.sender];
        require(order.lockedAmount == uint256(0), "Has pending deals!");

        // refund maker with left asset
        erc20(order.coinCode).transfer(msg.sender, order.leftAmount);

        uint256 orderID = orders[msg.sender].orderID;
        delete orders[msg.sender];
        emit CloseOrder(msg.sender, orderID);
    }

    function hasOrder(address maker) public view returns (bool) {
        return orders[maker].cTime > 0;
    }

    function updateOrder(uint256 price, uint256 amount) public orderExist(msg.sender) {
        orders[msg.sender].price = price;
        orders[msg.sender].leftAmount = amount;

        _updateOrder(msg.sender);
    }

    function _updateOrder(address user) internal {
        orders[user].uTime = block.timestamp;
        emit UpdateOrder(user, orders[user].orderID);
    }

    function updatePrice(uint256 price) public orderExist(msg.sender) {
        orders[msg.sender].price = price;

        _updateOrder(msg.sender);
    }

    function increaseAmount(uint256 amount) public orderExist(msg.sender) {
        require(amount > 0, "Increase amount should gt than 0!");

        Order storage order = orders[msg.sender];
        order.leftAmount = order.leftAmount.add(amount);

        _updateOrder(msg.sender);

        erc20(order.coinCode).transferFrom(msg.sender, address(this), amount);
    }

    function decreaseAmount(uint256 amount) public orderExist(msg.sender) {
        require(amount > 0, "Decrease amount should gt than 0!");

        Order storage order = orders[msg.sender];
        require(order.leftAmount >= amount, "Left amount is insufficient!");
        order.leftAmount = order.leftAmount.sub(amount);
        _updateOrder(msg.sender);

        // send back assets to user
        erc20(order.coinCode).transfer(msg.sender, amount);
    }

    function hasDeal(uint256 dealID) public view returns (bool) {
        return deals[dealID].cTime > 0;
    }

    function makeDeal(
        address maker,
        uint256 amount,
        bytes32 collateralType
    ) public {
        uint256 collateral = 0;

        // verifed user dose not need collateral
        if (otcDao().needCollateral(msg.sender)) {
            collateral = amount;
            if (dUSD != collateralType && USDT != collateralType) {
                // caculate required collateral amount
                collateral = exchangeRates().effectiveValue(dUSD, amount, collateralType);
            }
            collateral = lockedAsset(collateral, takerCRatio);

            // delegate collateral to frozen
            erc20(collateralType).transferFrom(msg.sender, address(this), collateral);
        } else {
            // recorde user has used one no collateral chance
            otcDao().useOneChance(msg.sender);
        }

        _makeDeal(maker, amount, collateralType, collateral);
    }

    //Deal
    function _makeDeal(
        address maker,
        uint256 amount,
        bytes32 collateralType,
        uint256 collateral
    ) internal returns (uint256) {
        // check order
        require(hasOrder(maker), "Maker has no active order!");

        // check traders
        require(msg.sender != maker, "Can not trade with self!");

        IOTCDao dao = otcDao();

        // check if deal taker is disallowed for trading
        require(!dao.isInBlackList(msg.sender), "Taker is disallowed for tradding!");

        // check min deal amount
        require(amount >= minTradeAmount, "Trade amount less than min!");

        // verified taker only make no more than maxTradeAmountForVerified
        if (dao.isInVerifyList(msg.sender) && amount > maxTradeAmountForVerified) {
            amount = maxTradeAmountForVerified;
        }

        // check exchange able set
        Order storage order = orders[maker];
        uint256 maxExangeableAsset = exchangeableAsset(order.leftAmount, makerCRatio);
        require(maxExangeableAsset >= amount, "Amount exceed order max excangeable!");
        uint256 lockedAmount = lockedAsset(amount, makerCRatio);
        order.leftAmount = order.leftAmount.sub(amount.add(lockedAmount));
        order.lockedAmount = order.lockedAmount.add(lockedAmount);

        _updateOrder(maker);

        // make deal
        Deal memory deal =
            Deal({
                coinCode: order.coinCode,
                currencyCode: order.currencyCode,
                orderID: order.orderID,
                dealID: dealCount,
                price: order.price,
                amount: amount,
                fee: tradeFee(amount),
                cTime: block.timestamp,
                uTime: block.timestamp,
                maker: maker,
                taker: msg.sender,
                dealState: DealState.Confirming
            });
        DealCollateral memory dealCollateral =
            DealCollateral({lockedAmount: lockedAmount, collateral: collateral, collateralType: collateralType});
        deals[deal.dealID] = deal;
        dealCollaterals[deal.dealID] = dealCollateral;

        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);

        // increase deal count
        dealCount++;

        return deal.dealID;
    }

    function cancelDeal(uint256 dealID) public dealExist(dealID) returns (bool) {
        Deal storage deal = deals[dealID];

        require(msg.sender == deal.taker, "Only taker can cancel deal!");
        require(deal.dealState == DealState.Confirming, "Deal state should be confirming!");

        // refund maker and taker
        Order storage order = orders[deal.maker];
        DealCollateral storage dealCollateral = dealCollaterals[deal.dealID];
        order.leftAmount = order.leftAmount.add(deal.amount).add(dealCollateral.lockedAmount);
        order.lockedAmount = order.lockedAmount.sub(dealCollateral.lockedAmount);
        _updateOrder(deal.maker);

        deal.dealState = DealState.Cancelled;
        deal.uTime = block.timestamp;

        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);

        // transfer DEM back to taker
        // note: verified user has no collateral
        if (dealCollateral.collateral > 0) {
            erc20(dealCollateral.collateralType).transfer(deal.taker, dealCollateral.collateral);
        }

        return true;
    }

    function confirmDeal(uint256 dealID) public dealExist(dealID) returns (bool) {
        Deal storage deal = deals[dealID];
        require(deal.dealState == DealState.Confirming, "Deal should be confirming!");
        require(msg.sender == deal.maker, "Only maker can confirm deal!");

        // unlocker maker and transfer asset to taker
        Order storage order = orders[deal.maker];
        DealCollateral storage dealCollateral = dealCollaterals[deal.dealID];

        order.leftAmount = order.leftAmount.add(dealCollateral.lockedAmount);
        order.lockedAmount = order.lockedAmount.sub(dealCollateral.lockedAmount);
        _updateOrder(deal.maker);

        // mark deal confirmed
        deal.dealState = DealState.Confirmed;
        deal.uTime = block.timestamp;

        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);

        // transfer charged erc20 token to taker
        erc20(deal.coinCode).transfer(deal.taker, deal.amount.sub(deal.fee));

        // fund treasury
        if (deal.fee > 0) {
            erc20(deal.coinCode).transfer(treasuryWallet, deal.fee);
        }

        // trans back taker collateral if no reward schedule applyed
        if ((uint256(0) == dealFrozenPeriod) && dealCollateral.collateral > 0) {
            erc20(dealCollateral.collateralType).transfer(deal.taker, dealCollateral.collateral);
        }

        return true;
    }

    function adjudicateDeal(
        uint256 dealID,
        address complainant,
        uint256 compensationRatio
    ) public onlyOTCDao dealExist(dealID) {
        Deal storage deal = deals[dealID];
        DealCollateral storage dealCollateral = dealCollaterals[deal.dealID];

        require((deal.cTime + dealExpiredPeriod) <= block.timestamp, "Deal is valid for confirmation!");
        require(deal.dealState == DealState.Confirming, "Deal should be confirming!");

        // bad guys need be punished here
        // all collateral shall be taken away, part go to Treasury
        // reset will compensate victim
        Order storage order = orders[deal.maker];
        if (deal.maker == complainant) {
            IOTCDao dao = otcDao();

            // taker dose not confirmed intime
            if (0 == dealCollateral.collateral) {
                // taker has no collateral in the case we need to forbid the address trading for ever
                dao.addToBlackList(deal.taker);
            } else {
                // take away all collateral
                uint256 compensation = dealCollateral.collateral.multiplyDecimalRound(compensationRatio);
                // compensate taker
                if (compensation > 0) {
                    erc20(dealCollateral.collateralType).transfer(deal.maker, compensation);
                }
                // to Treasury
                erc20(dealCollateral.collateralType).transfer(treasuryWallet, dealCollateral.collateral.sub(compensation));
            }

            // refund maker
            order.leftAmount = order.leftAmount.add(deal.amount).add(dealCollateral.lockedAmount);
            order.lockedAmount = order.lockedAmount.sub(dealCollateral.lockedAmount);
        } else if (deal.taker == complainant) {
            // maker dose not confirm deal after receiving offline
            uint256 compensation = dealCollateral.lockedAmount.multiplyDecimalRound(compensationRatio);

            IERC20 asset = erc20(deal.coinCode);
            // fund taker with trade amount exclude fee +  compensation
            asset.transfer(deal.taker, deal.amount.sub(deal.fee).add(compensation));
            // fund treasury with trade compensation + fee
            asset.transfer(treasuryWallet, dealCollateral.lockedAmount.sub(compensation).add(deal.fee));
            // refund taker Collateral
            if ((uint256(0) == dealFrozenPeriod) && dealCollateral.collateral > 0) {
                erc20(dealCollateral.collateralType).transfer(deal.taker, dealCollateral.collateral);
            }
            // decrease locked assets
            order.lockedAmount = order.lockedAmount.sub(dealCollateral.lockedAmount);
        } else {
            revert("Invalid complainant!");
        }
        // update order
        _updateOrder(deal.maker);

        // update deal
        deal.uTime = block.timestamp;
        deal.dealState = DealState.Adjudicated;
        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);

        emit AdjudicateDeal(complainant, deal.dealID);
    }

    function redeemCollateral(uint256 dealID) public dealExist(dealID) {
        Deal storage deal = deals[dealID];

        require(deal.dealState == DealState.Confirmed, "Deal not confirmed!");
        require(deal.taker == msg.sender, "Only taker can redeem collateral!");
        require(uint256(0) != dealFrozenPeriod, "No collateral trans back!");
        require(deal.uTime + dealFrozenPeriod <= block.timestamp, "Frozen period dose not end!");

        // Transfer collateral back to taker if reward schedule applyed
        DealCollateral storage dealCollateral = dealCollaterals[deal.dealID];
        if (dealCollateral.collateral > 0) {
            erc20(dealCollateral.collateralType).transfer(deal.taker, dealCollateral.collateral);
        }
    }

    function leftFrozenTime(uint256 dealID) public view dealExist(dealID) returns (uint256) {
        Deal storage deal = deals[dealID];
        require(uint256(0) != dealFrozenPeriod, "No collateral trans back!");
        require(deal.dealState == DealState.Confirmed, "Deal not confirmed!");

        return (deal.uTime + dealFrozenPeriod <= block.timestamp ? 0 : (deal.uTime + dealFrozenPeriod - block.timestamp));
    }

    modifier onlyOTCDao {
        require(msg.sender == address(otcDao()), "Only OTC DAO contract can adjudicate deal!");
        _;
    }

    modifier profileExist() {
        require(hasProfile(msg.sender), "Profile dose not exist!");
        _;
    }

    modifier dealExist(uint256 dealID) {
        require(hasDeal(dealID), "Deal dose not exist!");
        _;
    }

    modifier orderExist(address user) {
        require(hasOrder(user), "Order dose not exist!");
        _;
    }
}
