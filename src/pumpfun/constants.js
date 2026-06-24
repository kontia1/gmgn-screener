/**
 * PumpFun Bonding Curve Constants
 * From official IDL: https://github.com/pump-fun/pump-public-docs
 */
const { PublicKey } = require('@solana/web3.js');

// Program IDs
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// Instruction discriminators (from IDL)
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// PDA seeds
const GLOBAL_SEED = Buffer.from('global');
const BONDING_CURVE_SEED = Buffer.from('bonding-curve');
const CREATOR_VAULT_SEED = Buffer.from('creator-vault');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');
const GLOBAL_VOLUME_SEED = Buffer.from('global_volume_accumulator');
const USER_VOLUME_SEED = Buffer.from('user_volume_accumulator');
const FEE_CONFIG_SEED = Buffer.from('fee_config');

// Fee config key bytes (from IDL)
const FEE_CONFIG_KEY = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
  81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176
]);

// Well-known programs
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const RENT_PROGRAM = new PublicKey('SysvarRent111111111111111111111111111111111');

// PDA derivation helpers
function findGlobalPDA() {
  return PublicKey.findProgramAddressSync([GLOBAL_SEED], PUMP_PROGRAM)[0];
}

function findBondingCurvePDA(mint) {
  return PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, mint.toBuffer()],
    PUMP_PROGRAM
  )[0];
}

function findAssociatedBondingCurve(mint, bondingCurve) {
  return PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  )[0];
}

function findCreatorVault(creator) {
  return PublicKey.findProgramAddressSync(
    [CREATOR_VAULT_SEED, creator.toBuffer()],
    PUMP_PROGRAM
  )[0];
}

function findEventAuthority() {
  return PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], PUMP_PROGRAM)[0];
}

function findGlobalVolumeAccumulator() {
  return PublicKey.findProgramAddressSync([GLOBAL_VOLUME_SEED], PUMP_PROGRAM)[0];
}

function findUserVolumeAccumulator(user) {
  return PublicKey.findProgramAddressSync(
    [USER_VOLUME_SEED, user.toBuffer()],
    PUMP_PROGRAM
  )[0];
}

function findFeeConfig() {
  return PublicKey.findProgramAddressSync(
    [FEE_CONFIG_SEED, FEE_CONFIG_KEY],
    FEE_PROGRAM
  )[0];
}

module.exports = {
  PUMP_PROGRAM,
  FEE_PROGRAM,
  BUY_DISCRIMINATOR,
  SELL_DISCRIMINATOR,
  TOKEN_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  RENT_PROGRAM,
  findGlobalPDA,
  findBondingCurvePDA,
  findAssociatedBondingCurve,
  findCreatorVault,
  findEventAuthority,
  findGlobalVolumeAccumulator,
  findUserVolumeAccumulator,
  findFeeConfig,
};
