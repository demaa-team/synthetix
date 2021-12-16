pragma solidity ^0.5.16;

interface IOTC {
    enum DealState {Confirming, Cancelled, Confirmed}
    enum CurrencyCode {CNY, USD}

    //Personal profile
    function registerProfile(string calldata ipfsHash) external;

    function updateProfile(string calldata ipfsHash) external;

    function destroyProfile() external;

    function hasProfile(address user) external view returns (bool);

    function getProfileHash(address user) external view returns (string memory ipfsHash);

    //Order
    function openOrder(
        CurrencyCode code,
        uint256 price,
        uint256 amount
    ) external;

    function closeOrder() external;

    function hasOrder(address maker) external view returns (bool);

    function updateOrder(uint256 price, uint256 amount) external;

    function updatePrice(uint256 price) external;

    function increaseAmount(uint256 amount) external;

    function decreaseAmount(uint256 amount) external;

    //Deal
    function makeDeal(address maker, uint256 amount) external returns (uint256);

    function makeDealMax(address maker) external returns (uint256);

    function cancelDeal(uint256 dealID) external returns (bool);

    function confirmDeal(uint256 dealID) external returns (bool);

    function redeemCollateral(uint256 dealID) external;

    function hasDeal(uint256 dealID) external view returns (bool);

    function migrate(address newOTC) external;

    event RegisterProfile(address indexed from, string ipfsHash);
    event UpdateProfile(address indexed from, string ipfsHash);
    event DestroyProfile(address indexed from);

    event OpenOrder(address indexed from, uint256 orderID, CurrencyCode code, uint256 price, uint256 amount);
    event CloseOrder(address indexed from, uint256 orderID);
    event UpdateOrder(address indexed from, uint256 orderID, uint256 price, uint256 amount);

    event UpdateDeal(address indexed maker, address indexed taker, uint256 dealID, DealState dealState);
}
