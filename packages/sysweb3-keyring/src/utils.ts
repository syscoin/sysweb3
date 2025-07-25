import { logger } from 'ethers';
import { Logger, isHexString } from 'ethers/lib/utils';

const errorGas = ['call', 'estimateGas'];

function spelunk(
  value: any,
  requireData: boolean
): null | { data: null | string; message: string } {
  if (value == null) {
    return null;
  }

  // These *are* the droids we're looking for.
  if (typeof value.message === 'string' && value.message.match('reverted')) {
    const data = isHexString(value.data) ? value.data : null;
    if (!requireData || data) {
      return { message: value.message, data };
    }
  }

  // Spelunk further...
  if (typeof value === 'object') {
    for (const key in value) {
      const result = spelunk(value[key], requireData);
      if (result) {
        return result;
      }
    }
    return null;
  }

  // Might be a JSON string we can further descend...
  if (typeof value === 'string') {
    try {
      return spelunk(JSON.parse(value), requireData);
      // eslint-disable-next-line
    } catch (error) {}
  }

  return null;
}

export function checkError(method: string, error: any, params: any): any {
  const transaction = params.transaction || params.signedTransaction;

  // Undo the "convenience" some nodes are attempting to prevent backwards
  // incompatibility; maybe for v6 consider forwarding reverts as errors
  if (method === 'call') {
    const result = spelunk(error, true);
    if (result) {
      return result.data;
    }

    // Nothing descriptive..
    logger.throwError(
      'missing revert data in call exception; Transaction reverted without a reason string',
      Logger.errors.CALL_EXCEPTION,
      {
        data: '0x',
        transaction,
        error,
      }
    );
  }

  if (method === 'estimateGas') {
    // Try to find something, with a preference on SERVER_ERROR body
    let result = spelunk(error.body, false);
    if (result == null) {
      result = spelunk(error, false);
    }

    // Found "reverted", this is a CALL_EXCEPTION
    if (result) {
      logger.throwError(
        'cannot estimate gas; transaction may fail or may require manual gas limit',
        Logger.errors.UNPREDICTABLE_GAS_LIMIT,
        {
          reason: result.message,
          method,
          transaction,
          error,
        }
      );
    }
  }

  // @TODO: Should we spelunk for message too?

  let message = error.message;
  if (
    error.code === Logger.errors.SERVER_ERROR &&
    error.error &&
    typeof error.error.message === 'string'
  ) {
    message = error.error.message;
  } else if (typeof error.body === 'string') {
    message = error.body;
  } else if (typeof error.responseText === 'string') {
    message = error.responseText;
  }
  message = (message || '').toLowerCase();

  // "insufficient funds for gas * price + value + cost(data)"
  if (
    message.match(
      /insufficient funds|base fee exceeds gas limit|InsufficientFunds/i
    )
  ) {
    logger.throwError(
      'insufficient funds for intrinsic transaction cost',
      Logger.errors.INSUFFICIENT_FUNDS,
      {
        error,
        method,
        transaction,
      }
    );
  }

  // "nonce too low"
  if (message.match(/nonce (is )?too low/i)) {
    logger.throwError(
      'nonce has already been used',
      Logger.errors.NONCE_EXPIRED,
      {
        error,
        method,
        transaction,
      }
    );
  }

  // "replacement transaction underpriced"
  if (
    message.match(
      /replacement transaction underpriced|transaction gas price.*too low/i
    )
  ) {
    logger.throwError(
      'replacement fee too low',
      Logger.errors.REPLACEMENT_UNDERPRICED,
      {
        error,
        method,
        transaction,
      }
    );
  }

  // "replacement transaction underpriced"
  if (message.match(/only replay-protected/i)) {
    logger.throwError(
      'legacy pre-eip-155 transactions not supported',
      Logger.errors.UNSUPPORTED_OPERATION,
      {
        error,
        method,
        transaction,
      }
    );
  }

  if (
    errorGas.indexOf(method) >= 0 &&
    message.match(
      /gas required exceeds allowance|always failing transaction|execution reverted|revert/
    )
  ) {
    logger.throwError(
      'cannot estimate gas; transaction may fail or may require manual gas limit',
      Logger.errors.UNPREDICTABLE_GAS_LIMIT,
      {
        error,
        method,
        transaction,
      }
    );
  }

  throw error;
}

export const SYSCOIN_BASIC_FEE = 0.00001;

export const ONE_HUNDRED_MILLION = 1e8;

export const BIP_84 = 84;
