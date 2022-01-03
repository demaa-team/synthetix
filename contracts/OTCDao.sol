pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";
import "./interfaces/IOTCDao.sol";

// Libraries
import "./SafeDecimalMath.sol";

// reffer
import "./interfaces/IOTC.sol";

contract OTCDao is Owned, IOTCDao, MixinResolver {
    struct NoCollateral {
        bool verified;
        uint256 usedNoCollateralCount;
    }

    struct AdjudicationInfo {
        // id
        uint256 id;
        // deal id
        uint256 dealID;
        // plaintiff
        address plaintiff;
        // defendant
        address defendant;
        // adjudicator
        address adjudicator;
        // winner
        address winner;
        // evidence path in ipfs
        string evidence;
        // defendant explanation
        string explanation;
        // verdict
        string verdict;
        // progress
        AdjudicationState progress;
        uint256 cTime;
        uint256 uTime;
    }

    // name list who need has verified unique verify source
    mapping(address => NoCollateral) public verifiedList;
    // name list who is disallowed for trading for ever
    mapping(address => bool) public blackList;
    // record how many time a user violate rule
    mapping(address => uint256) public violationCount;
    // record adjudication info
    mapping(uint256 => AdjudicationInfo) public adjudications;
    // increase AdjudicationInfo count
    uint256 public adjudicationCount;
    // respond expired period
    uint256 public respondExpiredPeriod = 3 days;
    // compensate rate for victim
    uint256 public daoCompensationRatio = 0.5 ether;
    uint256 public selfCompensationRatio = 1 ether;
    // max trade chances with no collateral
    uint256 public maxNoCollateralTradeCount = 1;

    bytes32 private constant CONTRACT_OTC = "OTC";

    constructor(address _owner, address _resolver) public Owned(_owner) MixinResolver(_resolver) {}

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        addresses = new bytes32[](1);
        addresses[0] = CONTRACT_OTC;
    }

    function otc() internal view returns (IOTC) {
        return IOTC(requireAndGetAddress(CONTRACT_OTC));
    }

    function setCompensationRatio(uint256 _daoCompensationRatio, uint256 _selfCompensationRatio) public onlyOwner {
        daoCompensationRatio = _daoCompensationRatio;
        selfCompensationRatio = _selfCompensationRatio;
    }

    function setRespondExpiredPeriod(uint256 period) public onlyOwner {
        respondExpiredPeriod = period;
    }

    function setMaxNoCollateralTradeCount(uint256 count) public onlyOwner {
        maxNoCollateralTradeCount = count;
    }

    function addToVerifyList(address who) public onlyOwner {
        if (!verifiedList[who].verified) {
            verifiedList[who] = NoCollateral({verified: true, usedNoCollateralCount: 0});
        }

        emit UpdateVerifiedList(msg.sender, who, ListAction.Added);
    }

    function useOneChance(address who) public onlyOwnerOrOTC {
        if (verifiedList[who].verified) {
            verifiedList[who].usedNoCollateralCount++;
        }

        emit UpdateVerifiedList(msg.sender, who, ListAction.Updated);
    }

    function isInVerifyList(address who) public view returns (bool) {
        return verifiedList[who].verified;
    }

    function needCollateral(address who) public view returns (bool) {
        return !verifiedList[who].verified || (verifiedList[who].usedNoCollateralCount >= maxNoCollateralTradeCount);
    }

    function removeFromVerifyList(address who) public onlyOwner {
        delete verifiedList[who];

        emit UpdateVerifiedList(msg.sender, who, ListAction.Removed);
    }

    function addToBlackList(address who) public onlyOwnerOrOTC {
        blackList[who] = true;

        emit UpdateBlackList(msg.sender, who, ListAction.Added);
    }

    function removeFromBlackList(address who) public onlyOwner {
        delete blackList[who];

        emit UpdateBlackList(msg.sender, who, ListAction.Removed);
    }

    function increaseViolation(address who) internal {
        violationCount[who]++;

        emit UpdateViolationCount(msg.sender, who);
    }

    function isInBlackList(address who) public view returns (bool) {
        return blackList[who];
    }

    function applyAdjudication(uint256 dealID, string memory evidence) public dealAdjudicatable(dealID) {
        require(adjudications[dealID].cTime == 0, "Adjudication has existed!");

        (bool _, address maker, address taker) = otc().getDealInfo(dealID);

        address defendant;
        if (maker == msg.sender) {
            defendant = taker;
        } else if (taker == msg.sender) {
            defendant = maker;
        } else {
            revert("Invalid plaintiff!");
        }

        adjudications[dealID] = AdjudicationInfo({
            id: dealID,
            dealID: dealID,
            plaintiff: msg.sender,
            defendant: defendant,
            winner: address(0),
            adjudicator: address(0),
            evidence: evidence,
            explanation: "",
            verdict: "",
            progress: AdjudicationState.Applied,
            cTime: block.timestamp,
            uTime: block.timestamp
        });

        emit UpdateAdjudication(msg.sender, dealID);
        adjudicationCount++;
    }

    function respondAdjudication(uint256 dealID, string memory explanation) public {
        AdjudicationInfo storage adjudicationInfo = adjudications[dealID];

        require(adjudicationInfo.cTime > 0, "Adjudication not exist!");

        require(adjudicationInfo.progress == AdjudicationState.Applied, "Adjudication adjudicated!");

        require(msg.sender == adjudicationInfo.defendant, "Only defendant can respond!");

        require(block.timestamp < (adjudicationInfo.uTime + respondExpiredPeriod), "Respond exceed expired period!");

        adjudicationInfo.explanation = explanation;
        adjudicationInfo.progress = AdjudicationState.Responded;
        adjudicationInfo.uTime = block.timestamp;

        emit UpdateAdjudication(msg.sender, adjudicationInfo.id);
    }

    function adjudicate(
        uint256 dealID,
        address winner,
        string memory verdict
    ) public {
        AdjudicationInfo storage adjudicationInfo = adjudications[dealID];

        // Adjudication exist
        require(adjudicationInfo.cTime > 0, "Adjudication not exist!");

        // respond time has passed
        require((adjudicationInfo.cTime + respondExpiredPeriod) <= block.timestamp, "RespondExpiredPeriod is valid!");

        // Adjudication not adjudicated
        require(adjudicationInfo.progress != AdjudicationState.Adjudicated, "Adjudication adjudicated!");

        // if defendant dose not respond in respondExpiredPeriod, deal shall be adjudicated to plaintiff,
        // or the DAO give the result
        if (adjudicationInfo.progress == AdjudicationState.Responded) {
            require(msg.sender == owner, "Only the DAO can adjudicate!");

            // defendant has respond where the DAO shall give the result
            otc().adjudicateDeal(adjudicationInfo.dealID, winner, daoCompensationRatio);
            adjudicationInfo.winner = winner;
            adjudicationInfo.verdict = verdict;
        } else {
            // defendant has not respond where the result adjudicated to plaintiff
            // all Collateral go to winner
            winner = adjudicationInfo.plaintiff;
            otc().adjudicateDeal(adjudicationInfo.dealID, winner, selfCompensationRatio);
            adjudicationInfo.winner = adjudicationInfo.plaintiff;
            adjudicationInfo.verdict = "Defendant did not respond";
        }
        adjudicationInfo.adjudicator = msg.sender;
        adjudicationInfo.progress = AdjudicationState.Adjudicated;
        adjudicationInfo.uTime = block.timestamp;

        // update Violation count
        if (winner == adjudicationInfo.plaintiff) {
            increaseViolation(adjudicationInfo.defendant);
        } else {
            increaseViolation(adjudicationInfo.plaintiff);
        }

        emit UpdateAdjudication(msg.sender, adjudicationInfo.id);
    }

    modifier onlyOwnerOrOTC {
        require((msg.sender == owner || msg.sender == requireAndGetAddress(CONTRACT_OTC)), "Only owner or OTC!");
        _;
    }

    modifier dealAdjudicatable(uint256 dealID) {
        require(otc().hasDeal(dealID), "Deal not exists!");
        require(otc().isDealExpired(dealID), "Deal is not expired!");
        require(!otc().isDealClosed(dealID), "Deal closed!");
        _;
    }
}
