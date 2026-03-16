// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract EpochClearingLedger {
    address public engine;

    struct EpochResult {
        uint256 clearingPrice;
        uint8 slotsFilled;
        uint8 totalBids;
        address[] winners;
    }

    mapping(uint256 => EpochResult) public epochs;

    event EpochCleared(
        uint256 indexed epochId,
        uint256 clearingPrice,
        uint8 slotsFilled,
        uint8 totalBids,
        bytes32 resourceId
    );

    modifier onlyEngine() {
        require(msg.sender == engine, "Only engine");
        _;
    }

    constructor(address _engine) {
        engine = _engine;
    }

    function recordEpoch(
        uint256 epochId,
        uint256 clearingPrice,
        address[] calldata winners,
        uint8 totalBids,
        bytes32 resourceId
    ) external onlyEngine {
        require(epochs[epochId].slotsFilled == 0 && epochs[epochId].clearingPrice == 0, "Already recorded");

        epochs[epochId] = EpochResult({
            clearingPrice: clearingPrice,
            slotsFilled: uint8(winners.length),
            totalBids: totalBids,
            winners: winners
        });

        emit EpochCleared(epochId, clearingPrice, uint8(winners.length), totalBids, resourceId);
    }

    function getEpoch(uint256 epochId) external view returns (
        uint256 clearingPrice,
        uint8 slotsFilled,
        uint8 totalBids,
        address[] memory winners
    ) {
        EpochResult storage r = epochs[epochId];
        return (r.clearingPrice, r.slotsFilled, r.totalBids, r.winners);
    }
}
