// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ERC-8004 Agent Identity Registry
/// @notice Registers autonomous agent identities on-chain with operator delegation
contract AgentIdentityRegistry {

    struct AgentIdentity {
        address operator;       // wallet that controls this identity
        string  name;           // human-readable agent name
        string  serviceUri;     // agent.json or skill.md URI
        uint256 registeredAt;
        bool    active;
    }

    // identity address (deterministic) => identity data
    mapping(address => AgentIdentity) public identities;
    // operator wallet => identity address (one identity per operator)
    mapping(address => address) public operatorToIdentity;

    uint256 public totalRegistered;

    event AgentRegistered(
        address indexed identity,
        address indexed operator,
        string  name,
        string  serviceUri
    );

    event AgentDeactivated(address indexed identity);

    /// @notice Register a new agent identity. Caller becomes the operator.
    /// @param name Human-readable name (e.g. "Belle")
    /// @param serviceUri Pointer to agent.json or skill.md
    /// @return identity The deterministic identity address
    function register(string calldata name, string calldata serviceUri)
        external
        returns (address identity)
    {
        require(operatorToIdentity[msg.sender] == address(0), "Operator already registered");

        // Deterministic identity address from operator + name + timestamp
        identity = address(uint160(uint256(keccak256(
            abi.encodePacked(msg.sender, name, block.number)
        ))));

        identities[identity] = AgentIdentity({
            operator:     msg.sender,
            name:         name,
            serviceUri:   serviceUri,
            registeredAt: block.timestamp,
            active:       true
        });

        operatorToIdentity[msg.sender] = identity;
        totalRegistered++;

        emit AgentRegistered(identity, msg.sender, name, serviceUri);
    }

    /// @notice Check if an address is a valid, active agent identity
    function isValidIdentity(address identity) external view returns (bool) {
        return identities[identity].active;
    }

    /// @notice Get the operator wallet for an identity
    function operatorOf(address identity) external view returns (address) {
        return identities[identity].operator;
    }

    /// @notice Get the identity address for an operator wallet
    function identityOf(address operator) external view returns (address) {
        return operatorToIdentity[operator];
    }

    /// @notice Deactivate an identity (only operator can call)
    function deactivate(address identity) external {
        require(identities[identity].operator == msg.sender, "Not operator");
        identities[identity].active = false;
        emit AgentDeactivated(identity);
    }
}
