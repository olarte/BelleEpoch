FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY engine/ ./engine/
COPY api/ ./api/
COPY identity/ ./identity/
COPY contracts/addresses.json ./contracts/addresses.json
COPY contracts/EpochClearingLedger.sol ./contracts/EpochClearingLedger.sol
COPY contracts/AgentIdentityRegistry.sol ./contracts/AgentIdentityRegistry.sol
COPY sdk/ ./sdk/
COPY site/ ./site/
COPY skill.md ./skill.md
COPY agent.json ./agent.json
COPY agent_log.json ./agent_log.json

EXPOSE 3001

CMD ["node", "api/index.js"]
