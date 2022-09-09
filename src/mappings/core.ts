/* eslint-disable prefer-const */
import {
  BigInt,
  BigDecimal,
  store,
  Address,
  log,
} from "@graphprotocol/graph-ts";
import {
  Mint,
  Burn,
  Swap,
  Transfer,
  Sync,
} from "../../generated/templates/Pair/Pair";
import {
  Pair,
  Token,
  AthleteXFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle,
} from "../../generated/schema";

import {
  updatePairDayData,
  updateTokenDayData,
  updateAthleteXDayData,
  updatePairHourData,
} from "../utils/updater";

import {
  getMaticPriceInUSD,
  findMaticPerToken,
  getTrackedVolumeUSD,
  getTrackedLiquidityUSD,
} from "../utils/pricing";

import {
  convertTokenToDecimal,
  createUser,
  createLiquidityPosition,
  createLiquiditySnapshot,
} from "../utils/helper";

import {
  ADDRESS_ZERO,
  FACTORY_ADDRESS,
  ONE_BI,
  ZERO_BD,
  BI_18,
} from "../utils/constants";

let MINING_POOLS: string[] = [];

function isCompleteMint(mintId: string | null): boolean {
  if (!mintId) {
    log.error("Invalid mint id found", []);
    return false;
  }

  let mint = MintEvent.load(mintId);
  if (!mint) {
    log.error("MintEvent at {} not found", [mintId]);
    return false;
  }

  return mint.sender !== null; // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  let eventToAsHexString = event.params.to.toHex();
  let eventFromAsHexString = event.params.from.toHex();
  let eventHashAsHexString = event.transaction.hash.toHex();

  // ignore initial transfers for first adds
  if (
    eventToAsHexString == ADDRESS_ZERO &&
    event.params.value.equals(BigInt.fromI32(1000))
  ) {
    return;
  }

  // skip if staking/unstaking
  if (
    MINING_POOLS.includes(eventFromAsHexString) ||
    MINING_POOLS.includes(eventToAsHexString)
  ) {
    return;
  }

  // user stats
  let from = event.params.from;
  createUser(from);
  let to = event.params.to;
  createUser(to);

  // get pair and load contract
  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.error("Pair at {} not found", [event.address.toHex()]);
    return;
  }
  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.value, BI_18);

  // get or create transaction
  let transaction = Transaction.load(eventHashAsHexString);
  if (transaction === null) {
    transaction = new Transaction(eventHashAsHexString);
    transaction.block = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.burns = [];
    transaction.swaps = [];
  }

  // mints
  let mints = transaction.mints;
  if (event.params.from.toHex() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value);
    pair.save();

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        eventHashAsHexString
          .concat("-")
          .concat(BigInt.fromI32(mints.length).toString())
      );
      mint.transaction = transaction.id;
      mint.pair = pair.id;
      mint.to = event.params.to;
      mint.liquidity = value;
      mint.timestamp = transaction.timestamp;
      mint.transaction = transaction.id;
      mint.save();

      // update mints in transaction
      transaction.mints = mints.concat([mint.id]);

      // save entities
      transaction.save();
    } else {
      // if this logical mint included a fee mint, account for this
      let mintId = mints[mints.length - 1] as string;
      let mint = MintEvent.load(mintId);
      if (!mint) {
        log.error("Mint at {} not found", [mintId]);
        return;
      }
      mint.feeTo = mint.to;
      mint.to = to;
      mint.feeLiquidity = mint.liquidity;
      mint.liquidity = value;
      mint.save();

      // save entities
      transaction.save();
    }
  }

  // case where direct send first on MATIC withdrawals
  if (eventToAsHexString == pair.id) {
    let burns = transaction.burns;
    let burn = new BurnEvent(
      eventHashAsHexString
        .concat("-")
        .concat(BigInt.fromI32(burns.length).toString())
    );
    burn.transaction = transaction.id;
    burn.pair = pair.id;
    burn.liquidity = value;
    burn.timestamp = transaction.timestamp;
    burn.to = event.params.to;
    burn.sender = event.params.from;
    burn.needsComplete = true;
    burn.transaction = transaction.id;
    burn.save();

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id);
    transaction.burns = burns;
    transaction.save();
  }

  // burn
  if (
    event.params.to.toHex() == ADDRESS_ZERO &&
    event.params.from.toHex() == pair.id
  ) {
    pair.totalSupply = pair.totalSupply.minus(value);
    pair.save();

    // this is a new instance of a logical burn
    let burns = transaction.burns;
    let burnId = burns[burns.length - 1] as string;
    let burn: BurnEvent;
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burnId);
      if (!currentBurn) {
        log.error("Burn at {} not found", [burnId]);
        return;
      }
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent;
      } else {
        burn = new BurnEvent(
          event.transaction.hash
            .toHex()
            .concat("-")
            .concat(BigInt.fromI32(burns.length).toString())
        );
        burn.transaction = transaction.id;
        burn.needsComplete = false;
        burn.pair = pair.id;
        burn.liquidity = value;
        burn.transaction = transaction.id;
        burn.timestamp = transaction.timestamp;
      }
    } else {
      burn = new BurnEvent(
        event.transaction.hash
          .toHex()
          .concat("-")
          .concat(BigInt.fromI32(burns.length).toString())
      );
      burn.transaction = transaction.id;
      burn.needsComplete = false;
      burn.pair = pair.id;
      burn.liquidity = value;
      burn.transaction = transaction.id;
      burn.timestamp = transaction.timestamp;
    }

    // if this logical burn included a fee mint, account for this
    let mintId = mints[mints.length - 1] as string;
    if (mints.length !== 0 && !isCompleteMint(mintId)) {
      let mint = MintEvent.load(mintId);
      if (!mint) {
        log.error("Mint at {} not found", [mintId]);
        return;
      }
      burn.feeTo = mint.to;
      burn.feeLiquidity = mint.liquidity;
      // remove the logical mint
      store.remove("Mint", mintId);
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop();
      transaction.mints = mints;
      transaction.save();
    }
    burn.save();
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id;
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id);
    }
    transaction.burns = burns;
    transaction.save();
  }

  if (eventFromAsHexString != ADDRESS_ZERO && eventFromAsHexString != pair.id) {
    let fromUserLiquidityPosition = createLiquidityPosition(
      event.address,
      from
    );
    fromUserLiquidityPosition.liquidityTokenBalance =
      fromUserLiquidityPosition.liquidityTokenBalance.minus(
        convertTokenToDecimal(event.params.value, BI_18)
      );
    fromUserLiquidityPosition.save();
    createLiquiditySnapshot(fromUserLiquidityPosition, event);
  }

  if (eventToAsHexString != ADDRESS_ZERO && eventToAsHexString != pair.id) {
    let toUserLiquidityPosition = createLiquidityPosition(event.address, to);
    toUserLiquidityPosition.liquidityTokenBalance =
      toUserLiquidityPosition.liquidityTokenBalance.plus(
        convertTokenToDecimal(event.params.value, BI_18)
      );
    toUserLiquidityPosition.save();
    createLiquiditySnapshot(toUserLiquidityPosition, event);
  }

  transaction.save();
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.error("Pair at {} not found", [event.address.toHex()]);
    return;
  }
  let token0 = Token.load(pair.token0);
  if (!token0) {
    log.error("Token at {} not found", [pair.token0]);
    return;
  }
  let token1 = Token.load(pair.token1);
  if (!token1) {
    log.error("Token at {} not found", [pair.token1]);
    return;
  }
  let athleteX = AthleteXFactory.load(FACTORY_ADDRESS);
  if (!athleteX) {
    log.error("AthleteXFactory at {} not found", [FACTORY_ADDRESS]);
    return;
  }
  // reset factory liquidity by subtracting only tracked liquidity
  athleteX.totalLiquidityMATIC = athleteX.totalLiquidityMATIC.minus(
    pair.trackedReserveMATIC as BigDecimal
  );

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1);

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  if (pair.reserve1.notEqual(ZERO_BD))
    pair.token0Price = pair.reserve0.div(pair.reserve1);
  else pair.token0Price = ZERO_BD;
  if (pair.reserve0.notEqual(ZERO_BD))
    pair.token1Price = pair.reserve1.div(pair.reserve0);
  else pair.token1Price = ZERO_BD;

  let bundle = Bundle.load("1");
  if (!bundle) {
    log.error("Bundle at {} not found", ["1"]);
    return;
  }
  bundle.maticPrice = getMaticPriceInUSD();
  bundle.save();

  let t0DerivedMATIC = findMaticPerToken(token0 as Token);
  token0.derivedMATIC = t0DerivedMATIC;
  token0.derivedUSD = t0DerivedMATIC.times(bundle.maticPrice);
  token0.save();

  let t1DerivedMATIC = findMaticPerToken(token1 as Token);
  token1.derivedMATIC = t1DerivedMATIC;
  token1.derivedUSD = t1DerivedMATIC.times(bundle.maticPrice);
  token1.save();

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityMATIC: BigDecimal;
  if (bundle.maticPrice.notEqual(ZERO_BD)) {
    trackedLiquidityMATIC = getTrackedLiquidityUSD(
      bundle as Bundle,
      pair.reserve0,
      token0 as Token,
      pair.reserve1,
      token1 as Token
    ).div(bundle.maticPrice);
  } else {
    trackedLiquidityMATIC = ZERO_BD;
  }

  // use derived amounts within pair
  pair.trackedReserveMATIC = trackedLiquidityMATIC;
  pair.reserveMATIC = pair.reserve0
    .times(token0.derivedMATIC as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedMATIC as BigDecimal));
  pair.reserveUSD = pair.reserveMATIC.times(bundle.maticPrice);

  // use tracked amounts globally
  athleteX.totalLiquidityMATIC = athleteX.totalLiquidityMATIC.plus(
    trackedLiquidityMATIC
  );
  athleteX.totalLiquidityUSD = athleteX.totalLiquidityMATIC.times(
    bundle.maticPrice
  );

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1);

  // save entities
  pair.save();
  athleteX.save();
  token0.save();
  token1.save();
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (!transaction) {
    log.error("Transaction at {} not found", [event.transaction.hash.toHex()]);
    return;
  }
  let mints = transaction.mints;
  let mintId = mints[mints.length - 1] as string;
  let mint = MintEvent.load(mintId);
  if (!mint) {
    log.error("Mint at {} not found", [mintId]);
    return;
  }

  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.error("Pair at {} not found", [event.address.toHex()]);
    return;
  }

  let athleteX = AthleteXFactory.load(FACTORY_ADDRESS);
  if (!athleteX) {
    log.error("AthleteXFactory at {} not found", [FACTORY_ADDRESS]);
    return;
  }

  let token0 = Token.load(pair.token0);
  if (!token0) {
    log.error("Token at {} not found", [pair.token0]);
    return;
  }

  let token1 = Token.load(pair.token1);
  if (!token1) {
    log.error("Token at {} not found", [pair.token1]);
    return;
  }

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(
    event.params.amount0,
    token0.decimals
  );
  let token1Amount = convertTokenToDecimal(
    event.params.amount1,
    token1.decimals
  );

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // get new amounts of USD and MATIC for tracking
  let bundle = Bundle.load("1");
  if (!bundle) {
    log.error("Bundle at {} not found => core.ts:440", ["1"]);
    return;
  }

  let amountTotalUSD = BigDecimal.fromString("0");
  if (token0.derivedMATIC && token1.derivedMATIC) {
    amountTotalUSD = token1.derivedMATIC
      .times(token1Amount)
      .plus(token0.derivedMATIC.times(token0Amount))
      .times(bundle.maticPrice);
  }

  // update txn counts
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);
  athleteX.totalTransactions = athleteX.totalTransactions.plus(ONE_BI);

  // save entities
  token0.save();
  token1.save();
  pair.save();
  athleteX.save();

  mint.sender = event.params.sender;
  mint.amount0 = token0Amount as BigDecimal;
  mint.amount1 = token1Amount as BigDecimal;
  mint.logIndex = event.logIndex;
  mint.amountUSD = amountTotalUSD as BigDecimal;
  mint.save();

  // update the LP position
  let liquidityPosition = createLiquidityPosition(
    event.address,
    mint.to as Address
  );
  createLiquiditySnapshot(liquidityPosition, event);

  updatePairDayData(event);
  updatePairHourData(event);
  updateAthleteXDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    return;
  }

  let burns = transaction.burns;
  let burnId = burns[burns.length - 1] as string;
  let burn = BurnEvent.load(burnId);
  if (!burn) {
    log.error("Burn at {} not found", [burnId]);
    return;
  }

  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.error("Pair at {} not found", [event.address.toHex()]);
    return;
  }

  let athleteX = AthleteXFactory.load(FACTORY_ADDRESS);
  if (!athleteX) {
    log.error("AthleteXFactory at {} not found", []);
    return;
  }

  //update token info
  let token0 = Token.load(pair.token0);
  if (!token0) {
    log.error("Token at {} not found", [pair.token0]);
    return;
  }

  let token1 = Token.load(pair.token1);
  if (!token1) {
    log.error("Token at {} not found", [pair.token1]);
    return;
  }

  let token0Amount = convertTokenToDecimal(
    event.params.amount0,
    token0.decimals
  );
  let token1Amount = convertTokenToDecimal(
    event.params.amount1,
    token1.decimals
  );

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // get new amounts of USD and MATIC for tracking
  let bundle = Bundle.load("1");
  if (!bundle) {
    log.error("Bundle at {} not found", ["1"]);
    return;
  }

  let amountTotalUSD = BigDecimal.fromString("0");
  if (token0.derivedMATIC && token1.derivedMATIC) {
    amountTotalUSD = token1.derivedMATIC
      .times(token1Amount)
      .plus(token0.derivedMATIC.times(token0Amount))
      .times(bundle.maticPrice);
  }

  // update txn counts
  athleteX.totalTransactions = athleteX.totalTransactions.plus(ONE_BI);
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);

  // update global counter and save
  token0.save();
  token1.save();
  pair.save();
  athleteX.save();

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal;
  burn.amount1 = token1Amount as BigDecimal;
  // burn.to = event.params.to
  burn.logIndex = event.logIndex;
  burn.amountUSD = amountTotalUSD as BigDecimal;
  burn.save();

  // update the LP position
  let liquidityPosition = createLiquidityPosition(
    event.address,
    burn.sender as Address
  );
  createLiquiditySnapshot(liquidityPosition, event);

  updatePairDayData(event);
  updatePairHourData(event);
  updateAthleteXDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHex());
  if (!pair) {
    log.error("Pair at {} not found", [event.address.toHex()]);
    return;
  }

  let token0 = Token.load(pair.token0);
  if (!token0) {
    log.error("Token at {} not found", [pair.token0]);
    return;
  }

  let token1 = Token.load(pair.token1);
  if (!token1) {
    log.error("Token at {} not found", [pair.token1]);
    return;
  }

  let amount0In = convertTokenToDecimal(
    event.params.amount0In,
    token0.decimals
  );
  let amount1In = convertTokenToDecimal(
    event.params.amount1In,
    token1.decimals
  );
  let amount0Out = convertTokenToDecimal(
    event.params.amount0Out,
    token0.decimals
  );
  let amount1Out = convertTokenToDecimal(
    event.params.amount1Out,
    token1.decimals
  );

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In);
  let amount1Total = amount1Out.plus(amount1In);

  // MATIC/USD prices
  let bundle = Bundle.load("1");
  if (!bundle) {
    log.error("Bundle at {} not found", ["1"]);
    return;
  }

  // get total amounts of derived USD and MATIC for tracking
  let derivedAmountMATIC = BigDecimal.fromString("0");
  if (token0.derivedMATIC && token1.derivedMATIC) {
    derivedAmountMATIC = token1.derivedMATIC
      .times(amount1Total)
      .plus(token0.derivedMATIC.times(amount0Total))
      .div(BigDecimal.fromString("2"));
  }

  let derivedAmountUSD = derivedAmountMATIC.times(bundle.maticPrice);

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(
    bundle as Bundle,
    amount0Total,
    token0 as Token,
    amount1Total,
    token1 as Token
  );

  let trackedAmountMATIC: BigDecimal;
  if (bundle.maticPrice.equals(ZERO_BD)) {
    trackedAmountMATIC = ZERO_BD;
  } else {
    trackedAmountMATIC = trackedAmountUSD.div(bundle.maticPrice);
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out));
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD);
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out));
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD);
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD);
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);
  pair.save();

  // update global values, only used tracked amounts for volume
  let athleteX = AthleteXFactory.load(FACTORY_ADDRESS);
  if (!athleteX) {
    log.error("AthleteXFactory at {}  not found", [FACTORY_ADDRESS]);
    return;
  }

  athleteX.totalVolumeUSD = athleteX.totalVolumeUSD.plus(trackedAmountUSD);
  athleteX.totalVolumeMATIC =
    athleteX.totalVolumeMATIC.plus(trackedAmountMATIC);
  athleteX.untrackedVolumeUSD =
    athleteX.untrackedVolumeUSD.plus(derivedAmountUSD);
  athleteX.totalTransactions = athleteX.totalTransactions.plus(ONE_BI);

  // save entities
  pair.save();
  token0.save();
  token1.save();
  athleteX.save();

  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHex());
    transaction.block = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.swaps = [];
    transaction.burns = [];
  }
  let swaps = transaction.swaps;
  let swap = new SwapEvent(
    event.transaction.hash
      .toHex()
      .concat("-")
      .concat(BigInt.fromI32(swaps.length).toString())
  );

  // update swap event
  swap.transaction = transaction.id;
  swap.pair = pair.id;
  swap.timestamp = transaction.timestamp;
  swap.transaction = transaction.id;
  swap.sender = event.params.sender;
  swap.amount0In = amount0In;
  swap.amount1In = amount1In;
  swap.amount0Out = amount0Out;
  swap.amount1Out = amount1Out;
  swap.to = event.params.to;
  swap.from = event.transaction.from;
  swap.logIndex = event.logIndex;
  // use the tracked amount if we have it
  swap.amountUSD =
    trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD;
  swap.save();

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id);
  transaction.swaps = swaps;
  transaction.save();

  // update day entities
  let pairDayData = updatePairDayData(event);
  let pairHourData = updatePairHourData(event);
  let athleteXDayData = updateAthleteXDayData(event);
  let token0DayData = updateTokenDayData(token0 as Token, event);
  let token1DayData = updateTokenDayData(token1 as Token, event);

  // swap specific updating
  athleteXDayData.dailyVolumeUSD =
    athleteXDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  athleteXDayData.dailyVolumeMATIC =
    athleteXDayData.dailyVolumeMATIC.plus(trackedAmountMATIC);
  athleteXDayData.dailyVolumeUntracked =
    athleteXDayData.dailyVolumeUntracked.plus(derivedAmountUSD);
  athleteXDayData.save();

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 =
    pairDayData.dailyVolumeToken0.plus(amount0Total);
  pairDayData.dailyVolumeToken1 =
    pairDayData.dailyVolumeToken1.plus(amount1Total);
  pairDayData.dailyVolumeUSD =
    pairDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  pairDayData.save();

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 =
    pairHourData.hourlyVolumeToken0.plus(amount0Total);
  pairHourData.hourlyVolumeToken1 =
    pairHourData.hourlyVolumeToken1.plus(amount1Total);
  pairHourData.hourlyVolumeUSD =
    pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD);
  pairHourData.save();

  // swap specific updating for token0
  token0DayData.dailyVolumeToken =
    token0DayData.dailyVolumeToken.plus(amount0Total);
  token0DayData.dailyVolumeMATIC = token0DayData.dailyVolumeMATIC.plus(
    amount0Total.times(token0.derivedMATIC as BigDecimal)
  );
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total
      .times(token0.derivedMATIC as BigDecimal)
      .times(bundle.maticPrice)
  );
  token0DayData.save();

  // swap specific updating
  token1DayData.dailyVolumeToken =
    token1DayData.dailyVolumeToken.plus(amount1Total);
  token1DayData.dailyVolumeMATIC = token1DayData.dailyVolumeMATIC.plus(
    amount1Total.times(token1.derivedMATIC as BigDecimal)
  );
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total
      .times(token1.derivedMATIC as BigDecimal)
      .times(bundle.maticPrice)
  );
  token1DayData.save();
}
