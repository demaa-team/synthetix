pragma solidity ^0.5.16;

interface IOTCDao {
    enum AdjudicationState {Applied, Responded, Adjudicated}
    enum ListAction {Added, Updated, Removed}

    function addToVerifyList(address who) external;

    function removeFromVerifyList(address who) external;

    function addToBlackList(address who) external;

    function removeFromBlackList(address who) external;

    function isInVerifyList(address who) external view returns (bool);

    function needCollateral(address who) external view returns (bool);

    function useOneChance(address who) external;

    function isInBlackList(address who) external view returns (bool);

    event UpdateVerifiedList(address indexed from, address indexed who, ListAction action);
    event UpdateBlackList(address indexed from, address indexed who, ListAction action);
    event UpdateViolationCount(address indexed from, address indexed who);
    event UpdateAdjudication(address indexed from, uint256 adjudicationID);
}
