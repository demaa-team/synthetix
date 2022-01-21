pragma solidity ^0.5.16;

import "./IERC20.sol";

interface IOTC {
    enum DealState {Confirming, Cancelled, Confirmed, Adjudicated}

    //Personal profile
    function registerProfile(string calldata ipfsHash) external;

    function updateProfile(string calldata ipfsHash) external;

    function destroyProfile() external;

    function hasProfile(address user) external view returns (bool);

    function getProfileHash(address user) external view returns (string memory ipfsHash);

    //Order
    function openOrder(
        bytes32 coinCode,
        bytes32 currencyCode,
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
    function makeDeal(
        address maker,
        uint256 amount,
        bytes32 collateralType
    ) external;

    function cancelDeal(uint256 dealID) external returns (bool);

    function confirmDeal(uint256 dealID) external returns (bool);

    function redeemCollateral(uint256 dealID) external;

    function hasDeal(uint256 dealID) external view returns (bool);

    function migrate(bytes32[] calldata coinCodes, address newOTC) external;

    function addAsset(bytes32[] calldata coinCodes, IERC20[] calldata contracts) external;

    function removeAsset(bytes32 assetKey) external;

    function getDealInfo(uint256 dealID)
        external
        view
        returns (
            bool,
            address,
            address
        );

    function isDealExpired(uint256 dealID) external view returns (bool);

    function isDealClosed(uint256 dealID) external view returns (bool);

    function adjudicateDeal(
        uint256 dealID,
        address complainant,
        uint256 compensationRatio
    ) external;

    event RegisterProfile(address indexed from, string ipfsHash);
    event UpdateProfile(address indexed from, string ipfsHash);
    event DestroyProfile(address indexed from);

    event OpenOrder(address indexed from, uint256 orderID);
    event CloseOrder(address indexed from, uint256 orderID);
    event UpdateOrder(address indexed from, uint256 orderID);
    event UpdateDeal(address indexed maker, address indexed taker, uint256 dealID, DealState dealState);

    event AdjudicateDeal(address from, uint256 deal);
}
