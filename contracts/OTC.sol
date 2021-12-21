pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IOTC.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/ISynthetix.sol";

contract OTC is MixinResolver, IOTC, Owned {
    /* ========== LIBRARIES ========== */
    using SafeMath for uint;
    using SafeDecimalMath for uint;

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

    struct Deal {
        // underlying asset key
        bytes32 coinCode;
        // trade partener code
        bytes32 currencyCode;
        // order id
        uint256 orderID;
        // a increasement number for 0
        uint256 dealID;
        // deal price
        uint256 price;
        // deal amount
        uint256 amount;
        // locked amount
        uint256 lockedAmount;
        // collateral for make this deal
        uint256 collateral;
        // time when deal created or updated
        uint256 cTime;
        uint256 uTime;
        // record maker and taker
        address maker;
        address taker;
        // deal state
        DealState dealState;
    }

    // profile table
    mapping(address => Profile) public profiles;
    // order table
    mapping(address => Order) public orders;
    // deal table
    mapping(uint256 => Deal) public deals;
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
    uint256 public dealFrozenPeriod = 3 days;
    // collateral ration 200%
    uint256 public takerCRatio = 200000000000000000;
    uint256 public makerCRatio = 100000000000000000;
    uint256 public minTradeAmount = 50 * 1e18;

    bytes32 private constant DEM = "DEM";
    bytes32 private constant sUSD = "sUSD";
    bytes32 private constant CONTRACT_SYNTHETIX = "Synthetix";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";

    constructor(address _owner, address _resolver) public Owned(_owner) MixinResolver(_resolver) {}

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        addresses = new bytes32[](2);
        addresses[0] = CONTRACT_SYNTHETIX;
        addresses[1] = CONTRACT_EXRATES;
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

    function erc20(bytes32 coinCode) public view returns (IERC20) {
        return underlyingAssets[coinCode];
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

    // Personal profile
    function registerProfile(string memory ipfsHash) public {
        require(!hasProfile(msg.sender), "Profile exist!");

        profiles[msg.sender] = Profile({ipfsHash: ipfsHash, cTime: block.timestamp, uTime: block.timestamp});

        emit RegisterProfile(msg.sender, ipfsHash);

        userCount++;
    }

    function destroyProfile() public {
        require(hasProfile(msg.sender), "Profile dose not exist!");

        delete profiles[msg.sender];

        emit DestroyProfile(msg.sender);

        userCount--;
    }

    function updateProfile(string memory ipfsHash) public {
        require(hasProfile(msg.sender), "Profile dose not exist!");

        profiles[msg.sender].ipfsHash = ipfsHash;
        profiles[msg.sender].uTime = block.timestamp;

        emit UpdateProfile(msg.sender, ipfsHash);
    }

    function hasProfile(address user) public view returns (bool) {
        return profiles[user].cTime > 0;
    }

    function getProfileHash(address user) external view returns (string memory ipfsHash) {
        require(hasProfile(user), "Profile dose not exist!");
        return profiles[user].ipfsHash;
    }

    function getUserCount() public view returns (uint256) {
        return userCount;
    }

    function migrate(bytes32[] memory assetKeys, address newOTC) public onlyOwner {
        // Transfer erc20 asset to new otc
        for (uint256 i = 0; i < assetKeys.length; i++) {
            IERC20 asset = erc20(assetKeys[i]);
            if (address(asset) == address(0)) {
                revert("Unsuported underlying asset!");
            }

            asset.transfer(newOTC, asset.balanceOf(address(this)));
        }

        // Transfer dem to new otc
        synthetixERC20().transfer(newOTC, synthetixERC20().balanceOf(address(this)));
    }

    function maxExchangeableAsset(address maker) public view returns (uint256) {
        require(hasOrder(maker), "Oder dose not exist!");
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

    // Order
    function openOrder(
        bytes32 coinCode,
        bytes32 currencyCode,
        uint256 price,
        uint256 amount
    ) public {
        require(hasProfile(msg.sender), "Profile dose not exist!");
        require(!hasOrder(msg.sender), "Order has exist!");

        IERC20 asset = erc20(coinCode);
        if (address(asset) == address(0)) {
            revert("Unsuported underlying asset!");
        }

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

    function closeOrder() public {
        require(hasProfile(msg.sender), "Profile dose not exist!");
        require(hasOrder(msg.sender), "Order dose not exist!");

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

    function updateOrder(uint256 price, uint256 amount) public {
        require(hasOrder(msg.sender), "Order dose not exists!");

        orders[msg.sender].price = price;
        orders[msg.sender].leftAmount = amount;

        _updateOrder(msg.sender);
    }

    function _updateOrder(address user) internal {
        orders[user].uTime = block.timestamp;
        emit UpdateOrder(user, orders[user].orderID);
    }

    function updatePrice(uint256 price) public {
        require(hasOrder(msg.sender), "Order dose not exists!");

        orders[msg.sender].price = price;

        _updateOrder(msg.sender);
    }

    function increaseAmount(uint256 amount) public {
        require(amount > 0, "Increase amount should gt than 0!");
        require(hasOrder(msg.sender), "Order dose not exists!");

        Order storage order = orders[msg.sender];
        order.leftAmount = order.leftAmount.add(amount);

        _updateOrder(msg.sender);

        erc20(order.coinCode).transferFrom(msg.sender, address(this), amount);
    }

    function decreaseAmount(uint256 amount) public {
        require(amount > 0, "Decrease amount should gt than 0!");
        require(hasOrder(msg.sender), "Order dose not exists!");

        Order storage order = orders[msg.sender];
        require(order.leftAmount >= amount, "Leftamount is insufficient!");
        order.leftAmount = order.leftAmount.sub(amount);
        _updateOrder(msg.sender);

        // send back assets to user
        erc20(order.coinCode).transfer(msg.sender, amount);
    }

    function hasDeal(uint256 dealID) public view returns (bool) {
        return deals[dealID].cTime > 0;
    }

    //Deal
    function makeDeal(address maker, uint256 amount) public returns (uint256) {
        // check traders
        require(msg.sender != maker, "Can not trade with self!");

        // check min deal amount
        require(amount >= minTradeAmount, "Trade amount less than min!");

        // check order
        require(hasOrder(maker), "Maker has no active order!");

        // check exchange able set
        Order storage order = orders[maker];
        uint256 maxExangeableAsset = exchangeableAsset(order.leftAmount, makerCRatio);
        require(maxExangeableAsset >= amount, "Amount exceed order max excangeable!");
        uint256 lockedAmount = lockedAsset(amount, makerCRatio);
        order.leftAmount = order.leftAmount.sub(amount.add(lockedAmount));
        order.lockedAmount = order.lockedAmount.add(lockedAmount);

        _updateOrder(maker);

        // caculate required collateral amount
        // TODO: replace sUSD with target asset
        uint256 collateral = exchangeRates().effectiveValue(sUSD, amount, DEM);
        collateral = lockedAsset(collateral, takerCRatio);

        // delegate collateral to frozen
        synthetixERC20().transferFrom(msg.sender, address(this), collateral);

        // 4. make deal
        Deal memory deal =
            Deal({
                coinCode: order.coinCode,
                currencyCode: order.currencyCode,
                orderID: order.orderID,
                dealID: dealCount,
                price: order.price,
                amount: amount,
                lockedAmount: lockedAmount,
                collateral: collateral,
                cTime: block.timestamp,
                uTime: block.timestamp,
                maker: maker,
                taker: msg.sender,
                dealState: DealState.Confirming
            });
        deals[deal.dealID] = deal;

        // increase deal count
        dealCount++;

        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);

        return deal.dealID;
    }

    function makeDealMax(address maker) public returns (uint256) {
        return makeDeal(maker, maxTradeAmount(msg.sender));
    }

    function maxTradeAmount(address taker) public view returns (uint256) {
        uint256 collateral = synthetix().transferableSynthetix(taker).divideDecimalRound(takerCRatio);
        return exchangeRates().effectiveValue(DEM, collateral, sUSD);
    }

    function cancelDeal(uint256 dealID) public returns (bool) {
        Deal storage deal = deals[dealID];

        require(hasDeal(dealID), "Deal dose not exist!");
        require(msg.sender == deal.taker, "Only taker can cancel deal!");
        require(deal.dealState == DealState.Confirming, "Deal state should be confirming!");

        // refund maker and taker
        Order storage order = orders[deal.maker];
        order.leftAmount = order.leftAmount.add(deal.amount).add(deal.lockedAmount);
        order.lockedAmount = order.lockedAmount.sub(deal.lockedAmount);
        _updateOrder(deal.maker);

        deal.dealState = DealState.Cancelled;
        deal.uTime = block.timestamp;

        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);

        // transfer DEM back to taker
        synthetixERC20().transfer(deal.taker, deal.collateral);
    }

    function confirmDeal(uint256 dealID) public returns (bool) {
        Deal storage deal = deals[dealID];
        require(hasDeal(dealID), "Deal dose not exist!");
        require(deal.dealState == DealState.Confirming, "Deal should be confirming!");
        require(msg.sender == deal.maker, "Only maker can confirm deal!");

        // unlocker maker and transfer asset to taker
        Order storage order = orders[deal.maker];
        order.leftAmount = order.leftAmount.add(deal.lockedAmount);
        order.lockedAmount = order.lockedAmount.sub(deal.lockedAmount);
        _updateOrder(deal.maker);

        // mark deal confirmed
        deal.dealState = DealState.Confirmed;
        deal.uTime = block.timestamp;

        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);

        // transfer erc20 token to taker
        erc20(deal.coinCode).transfer(deal.taker, deal.amount);

        // TODO: distribute trade reward
    }

    function redeemCollateral(uint256 dealID) public {
        Deal storage deal = deals[dealID];
        require(hasDeal(dealID), "Deal dose not exist!");
        require(deal.dealState == DealState.Confirmed, "Deal not confirmed!");
        require(deal.taker == msg.sender, "Only taker can redeem collateral!");
        require(deal.uTime + dealFrozenPeriod <= block.timestamp, "Frozen period dose not end!");

        // Transfer collateral back to taker
        synthetixERC20().transfer(deal.taker, deal.collateral);
    }

    function leftFrozenTime(uint256 dealID) public view returns (uint256) {
        Deal storage deal = deals[dealID];
        require(hasDeal(dealID), "Deal dose not exist!");
        require(deal.dealState == DealState.Confirmed, "Deal not confirmed!");

        return (deal.uTime + dealFrozenPeriod <= block.timestamp ? 0 : (deal.uTime + dealFrozenPeriod - block.timestamp));
    }
}
