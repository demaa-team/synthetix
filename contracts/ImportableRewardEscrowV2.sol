pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseRewardEscrowV2.sol";

// https://docs.synthetix.io/contracts/RewardEscrow
contract ImportableRewardEscrowV2 is BaseRewardEscrowV2 {
    /* ========== CONSTRUCTOR ========== */

    constructor(address _owner, address _resolver) public BaseRewardEscrowV2(_owner, _resolver) {}

    /* ========== VIEWS ======================= */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        return BaseRewardEscrowV2.resolverAddressesRequired();
    }

    function synthetixBridgeToBase() internal view returns (address) {
        return address(0);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function importVestingEntries(
        address account,
        uint256 escrowedAmount,
        VestingEntries.VestingEntry[] calldata vestingEntries
    ) external onlySynthetixBridge {
        // There must be enough balance in the contract to provide for the escrowed balance.
        totalEscrowedBalance = totalEscrowedBalance.add(escrowedAmount);
        require(
            totalEscrowedBalance <= IERC20(address(synthetix())).balanceOf(address(this)),
            "Insufficient balance in the contract to provide for escrowed balance"
        );

        /* Add escrowedAmount to account's escrowed balance */
        totalEscrowedAccountBalance[account] = totalEscrowedAccountBalance[account].add(escrowedAmount);

        for (uint i = 0; i < vestingEntries.length; i++) {
            _importVestingEntry(account, vestingEntries[i]);
        }
    }

    function _importVestingEntry(address account, VestingEntries.VestingEntry memory entry) internal {
        uint entryID = nextEntryId;
        vestingSchedules[account][entryID] = entry;

        /* append entryID to list of entries for account */
        accountVestingEntryIDs[account].push(entryID);

        /* Increment the next entry id. */
        nextEntryId = nextEntryId.add(1);
    }

    modifier onlySynthetixBridge() {
        require(msg.sender == synthetixBridgeToBase(), "Can only be invoked by SynthetixBridgeToBase contract");
        _;
    }
}
