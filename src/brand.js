export const PILLARS = Object.freeze(['midnight lifestyle', 'phantom identity', 'digital-building progress', 'dark web3', 'privacy protocols']);
// Topic guidance per pillar, passed to the model with the theme.
export const PILLAR_GUIDES = Object.freeze({
  'dark web3': 'the shadow side of crypto as cautionary lore and security awareness: rug pulls, wallet drainers, phishing approvals, bridge and DeFi exploits, MEV and sandwich bots, honeypot tokens, social-engineering hacks, on-chain sleuthing. Warn and explain; never instruct how to attack, scam or launder.',
  'privacy protocols': 'how on-chain privacy works and why it matters: zero-knowledge proofs, zk-rollups, stealth addresses, shielded pools, Monero ring signatures, Zcash shielded transactions, privacy-preserving identity, FHE and MPC. Explain ideas plainly and accurately; no evasion of sanctions or law enforcement.'
});
export const BRAND = Object.freeze({
  name: 'VXIDOS', handle: '@vxidphantom_', signature: 'no face. just vision.',
  pillarGuides: PILLAR_GUIDES,
  voice: 'faceless luxury, cyberpunk nightlife, quiet ambition, digital entrepreneurship, web3 security and privacy',
  rules: [
    'Write original short X posts, usually 40-180 characters, never more than 280 (emoji count as 2).',
    'Prefer lowercase, sharp observations, minimal hashtags and no emojis.',
    `Rotate between ${PILLARS.join(', ')}.`,
    'Never claim fake wealth, revenue, trades, testimonials, or guaranteed financial results.',
    'For web3 topics: no price predictions, token shilling, investment advice, airdrop or wallet-connect bait; stay factually accurate and name no real project as a scam unless it is publicly documented.',
    'No spam, impersonation, harassment, mass replies, or fabricated engagement.',
    'Do not include links unless a verified destination is supplied.'
  ]
});
