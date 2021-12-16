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
        // uinique order id
        uint256 orderID;
        // Price of order
        uint256 price;
        // Left usdt amount not been selled
        uint256 leftAmount;
        // timestapm when order created
        uint256 cTime;
        uint256 uTime;
        // trade partener code
        CurrencyCode code;
    }

    struct Deal {
        // a increasement number for 0
        uint256 dealID;
        // deal price
        uint256 price;
        // deal amount
        uint256 amount;
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
        // trade partener code
        CurrencyCode code;
    }

    // erc20 contract address
    address private _erc20;
    // profile table
    mapping(address => Profile) public profiles;
    // order table
    mapping(address => Order) public orders;
    // deal table
    mapping(uint256 => Deal) public deals;
    // count users
    uint256 public userCount;
    // an incresement number used for generating order id
    uint256 public orderCount;
    // an incresement number used for generating deal id
    uint256 public dealCount;
    // collater forzen period before taker redeem collateral
    uint256 public dealFrozenPeriod = 3 days;
    // collateral ration 200%
    uint256 public collateralRatio = 500000000000000000;
    uint256 public minTradeAmount = 50 * 1e18;

    bytes32 private constant DEM = "DEM";
    bytes32 private constant sUSD = "sUSD";
    bytes32 private constant CONTRACT_SYNTHETIX = "Synthetix";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";

    constructor(
        address _asset,
        address _owner,
        address _resolver
    ) public Owned(_owner) MixinResolver(_resolver) {
        _erc20 = _asset;
    }

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

    function erc20() public view returns (IERC20) {
        require(_erc20 != address(0), "invalid erc20 address");
        return IERC20(_erc20);
    }

    function getCollateralRatio() public view returns (uint256) {
        return collateralRatio;
    }

    function setCollateralRatio(uint256 cRatio) public onlyOwner {
        collateralRatio = cRatio;
    }

    function getMinTradeAmount() public view returns (uint256) {
        return minTradeAmount;
    }

    function setMinTradeAmount(uint256 minAmount) public onlyOwner {
        minTradeAmount = minAmount;
    }

    function getDealFrozenPeriod() public view returns (uint256) {
        return dealFrozenPeriod;
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

    function migrate(address newOTC) public onlyOwner {
        // Transfer erc20 asset to new otc
        erc20().transfer(newOTC, erc20().balanceOf(address(this)));

        // Transfer dem to new otc
        synthetixERC20().transfer(newOTC, synthetixERC20().balanceOf(address(this)));
    }

    // Order
    function openOrder(
        CurrencyCode code,
        uint256 price,
        uint256 amount
    ) public {
        require(hasProfile(msg.sender), "Profile dose not exist!");

        // delegate token to this
        erc20().transferFrom(msg.sender, address(this), amount);

        // create order
        orders[msg.sender] = Order({
            orderID: orderCount,
            code: code,
            price: price,
            leftAmount: amount,
            cTime: block.timestamp,
            uTime: block.timestamp
        });

        emit OpenOrder(msg.sender, orderCount, code, price, amount);

        orderCount++;
    }

    function closeOrder() public {
        require(hasProfile(msg.sender), "Profile dose not exist!");

        uint256 orderID = orders[msg.sender].orderID;

        delete orders[msg.sender];

        emit CloseOrder(msg.sender, orderID);
    }

    function hasOrder(address maker) public view returns (bool) {
        return orders[maker].cTime > 0;
    }

    function updateOrder(uint256 price, uint256 amount) public {
        _updateOrder(msg.sender, price, amount);
    }

    function _updateOrder(
        address user,
        uint256 price,
        uint256 amount
    ) internal {
        require(hasOrder(user), "Order dose not exists!");

        orders[user].price = price;
        orders[user].leftAmount = amount;
        orders[user].uTime = block.timestamp;

        emit UpdateOrder(user, orders[user].orderID, price, amount);
    }

    function updatePrice(uint256 price) public {
        _updateOrder(msg.sender, price, orders[msg.sender].leftAmount);
    }

    function increaseAmount(uint256 amount) public {
        require(amount > 0, "Increase amount should gt than 0!");
        require(hasOrder(msg.sender), "Order dose not exists!");

        erc20().transferFrom(msg.sender, address(this), amount);

        _updateOrder(msg.sender, orders[msg.sender].price, orders[msg.sender].leftAmount.add(amount));
    }

    function decreaseAmount(uint256 amount) public {
        require(amount > 0, "Decrease amount should gt than 0!");
        require(hasOrder(msg.sender), "Order dose not exists!");
        require(orders[msg.sender].leftAmount >= amount, "Leftamount is insufficient!");

        // send back assets to user
        erc20().transfer(address(this), amount);

        _updateOrder(msg.sender, orders[msg.sender].price, orders[msg.sender].leftAmount.sub(amount));
    }

    function hasDeal(uint256 dealID) public view returns (bool) {
        return deals[dealID].cTime > 0;
    }

    //Deal
    function makeDeal(address maker, uint256 amount) public returns (uint256) {
        require(msg.sender != maker, "Can not trade with self");

        // 1. check requirment
        require(hasOrder(maker), "Maker has no active order!");
        Order storage order = orders[maker];
        require(order.leftAmount >= amount, "Amount exceed order left amount!");
        require(amount >= minTradeAmount, "Trade amount less than min!");

        // 2. caculate required collateral amount
        // TODO: replace sUSD with target asset
        uint256 collateral = exchangeRates().effectiveValue(sUSD, amount, DEM);
        collateral = collateral.divideDecimalRound(getCollateralRatio());

        // 2. delegate collateral to frozen
        synthetixERC20().transferFrom(msg.sender, address(this), collateral);

        // 4. make deal
        Deal memory deal =
            Deal({
                dealID: dealCount,
                code: order.code,
                price: order.price,
                amount: amount,
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

        // update left amount of order
        _updateOrder(maker, order.price, order.leftAmount.sub(amount));

        return deal.dealID;
    }

    function makeDealMax(address maker) public returns (uint256) {
        return makeDeal(maker, maxTradeAmount(msg.sender));
    }

    function maxTradeAmount(address taker) public view returns (uint256) {
        uint256 collateral = synthetix().transferableSynthetix(taker).multiplyDecimalRound(getCollateralRatio());
        return exchangeRates().effectiveValue(DEM, collateral, sUSD);
    }

    function cancelDeal(uint256 dealID) public returns (bool) {
        Deal storage deal = deals[dealID];

        require(hasDeal(dealID), "Deal dose not exist!");
        require(msg.sender == deal.taker, "Only taker can cancel deal!");
        require(deal.dealState == DealState.Confirming, "Deal state should be confirming!");

        // transfer erc20 token back to maker
        erc20().transfer(deal.maker, deal.amount);

        // transfer DEM back to taker
        synthetixERC20().transfer(deal.taker, deal.collateral);

        deal.dealState = DealState.Cancelled;
        deal.uTime = block.timestamp;

        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);
    }

    function confirmDeal(uint256 dealID) public returns (bool) {
        Deal storage deal = deals[dealID];
        require(hasDeal(dealID), "Deal dose not exist!");
        require(deal.dealState == DealState.Confirming, "Deal should be confirming!");
        require(msg.sender == deal.maker, "Only maker can confirm deal!");

        // transfer erc20 token to taker
        erc20().transfer(deal.taker, deal.amount);

        // mark deal confirmed
        deal.dealState = DealState.Confirmed;
        deal.uTime = block.timestamp;

        emit UpdateDeal(deal.maker, deal.taker, deal.dealID, deal.dealState);

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

        return (deal.uTime + dealFrozenPeriod <= block.timestamp ? 0 : block.timestamp - deal.uTime);
    }
}
