import { Networkish } from '@ethersproject/networks';
import { BigNumber, ethers, logger } from 'ethers';
import { ConnectionInfo, Logger, shallowCopy } from 'ethers/lib/utils';
import { Provider } from 'zksync-ethers';

import { handleStatusCodeError } from './errorUtils';
import { checkError } from './utils';

class BaseProvider extends ethers.providers.JsonRpcProvider {
  private isPossibleGetChainId = true;
  private cooldownTime = 120 * 1000;
  private rateLimit = 30;
  private requestCount = 0;
  private lastRequestTime = 0;
  private currentChainId = '';
  private currentId = 1;
  public isInCooldown = false;
  public errorMessage: any = '';
  public serverHasAnError = false;
  signal: AbortSignal;
  _pendingBatchAggregator: NodeJS.Timer | null;
  _pendingBatch: Array<{
    reject: (error: Error) => void;
    request: { id: number; jsonrpc: '2.0'; method: string; params: Array<any> };
    resolve: (result: any) => void;
  }> | null;

  constructor(
    signal: AbortSignal,
    url?: ConnectionInfo | string,
    network?: Networkish
  ) {
    super(url, network);
    this.signal = signal;
    this._pendingBatchAggregator = null;
    this._pendingBatch = null;

    this.bindMethods();
  }

  private bindMethods() {
    const proto = Object.getPrototypeOf(this);
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (typeof this[key] === 'function' && key !== 'constructor') {
        this[key] = this[key].bind(this);
      }
    }
  }

  private throttledRequest = <T>(requestFn: () => Promise<T>): Promise<T> => {
    if (!this.canMakeRequest()) {
      return this.cooldown();
    }
    // Execute request immediately without timeout delay
    return requestFn().catch((error) => {
      if (error.name === 'AbortError') {
        console.log('Aborted request', error);
        return Promise.reject(error);
      }
      throw error;
    });
  };
  private canMakeRequest = () => {
    const now = Date.now();
    let elapsedTime = 0;
    if (this.lastRequestTime > 0) {
      elapsedTime = now - this.lastRequestTime;
    }
    if (elapsedTime <= this.cooldownTime && this.serverHasAnError) {
      this.isInCooldown = true;
      return false;
    }

    if (elapsedTime >= this.cooldownTime && this.serverHasAnError) {
      this.requestCount = 0;
      this.serverHasAnError = false;
      this.isInCooldown = true;
      return false; //One last blocked request before cooldown ends
    }

    if (this.requestCount < this.rateLimit || !this.serverHasAnError) {
      this.requestCount++;
      if (elapsedTime > 1000) {
        //Uncomment the console.log to see the request per second
        // console.log(
        //   `Request/sec to Provider(${this.connection.url}): ${this.requestCount}`
        // );
        this.requestCount = 1;
        this.lastRequestTime = now;
      } else if (this.lastRequestTime === 0) {
        this.lastRequestTime = now;
      }
      this.isInCooldown = false;
      return true;
    }
  };

  private cooldown = async () => {
    const now = Date.now();
    const elapsedTime = now - this.lastRequestTime;
    console.error(
      'Cant make request, rpc cooldown is active for the next: ',
      (this.cooldownTime - elapsedTime) / 1000,
      ' seconds'
    );
    throw {
      message: `Cant make request, rpc cooldown is active for the next: ${
        (this.cooldownTime - elapsedTime) / 1000
      } seconds`,
    };
  };

  async perform(method: string, params: any): Promise<any> {
    // Legacy networks do not like the type field being passed along (which
    // is fair), so we delete type if it is 0 and a non-EIP-1559 network
    if (method === 'call' || method === 'estimateGas') {
      const tx = params.transaction;
      if (tx && tx.type != null && BigNumber.from(tx.type).isZero()) {
        // If there are no EIP-1559 properties, it might be non-EIP-1559
        if (tx.maxFeePerGas == null && tx.maxPriorityFeePerGas == null) {
          const feeData = await this.getFeeData();
          if (
            feeData.maxFeePerGas == null &&
            feeData.maxPriorityFeePerGas == null
          ) {
            // Network doesn't know about EIP-1559 (and hence type)
            params = shallowCopy(params);
            params.transaction = shallowCopy(tx);
            delete params.transaction.type;
          }
        }
      }
    }

    const args = this.prepareRequest(method, params);

    if (args == null) {
      logger.throwError(
        method + ' not implemented',
        Logger.errors.NOT_IMPLEMENTED,
        { operation: method }
      );
    }
    try {
      return await this.send(args[0], args[1]);
    } catch (error) {
      return checkError(method, error, params);
    }
  }

  override send = async (method: string, params: any[]) => {
    if (!this.isPossibleGetChainId && method === 'eth_chainId') {
      return this.currentChainId;
    }

    const headers = {
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: this.currentId,
      }),
      signal: this.signal,
    };

    const result = await this.throttledRequest(() =>
      fetch(this.connection.url, options)
        .then(async (response) => {
          if (!response.ok) {
            let errorBody = {
              error: undefined,
              message: undefined,
            };
            try {
              errorBody = await response.json();
            } catch (error) {
              console.warn('No body in request', error);
            }
            this.errorMessage =
              errorBody.error ||
              errorBody.message ||
              'No message from Provider';
            handleStatusCodeError(response.status, this.errorMessage);
          }
          switch (response.status) {
            case 200:
              return response.json();
            default:
              throw {
                message: `Unexpected HTTP status code: ${response.status}`,
              };
          }
        })
        .then((json) => {
          if (json.error) {
            if (json.error.message.includes('insufficient funds')) {
              console.error({
                errorMessage: json.error.message,
              });
              this.errorMessage = json.error.message;
              throw new Error(json.error.message);
            }
            this.errorMessage = json.error.message;
            console.log({ requestData: { method, params }, error: json.error });
            console.error({
              errorMessage: json.error.message,
            });
            throw new Error(json.error.message);
          }
          if (method === 'eth_chainId') {
            this.currentChainId = json.result;
            this.isPossibleGetChainId = false;
          }
          this.currentId++;
          this.serverHasAnError = false;
          return json.result;
        })
    );
    return result;
  };

  async sendBatch(method: string, params: Array<any[]>): Promise<any[]> {
    // Create batch request array
    const requests = params.map((param, index) => ({
      jsonrpc: '2.0',
      id: this.currentId + index,
      method,
      params: param,
    }));

    this.currentId += requests.length;

    const headers = {
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(requests),
      signal: this.signal,
    };

    const results = await this.throttledRequest(() =>
      fetch(this.connection.url, options)
        .then(async (response) => {
          if (!response.ok) {
            let errorBody = {
              error: undefined,
              message: undefined,
            };
            try {
              errorBody = await response.json();
            } catch (error) {
              console.warn('No body in request', error);
            }
            this.errorMessage =
              errorBody.error ||
              errorBody.message ||
              'No message from Provider';
            handleStatusCodeError(response.status, this.errorMessage);
          }
          return response.json();
        })
        .then((jsonArray) => {
          // Sort results by ID to ensure correct order
          const sortedResults = jsonArray.sort((a: any, b: any) => a.id - b.id);

          // Extract results or throw errors
          return sortedResults.map((json: any) => {
            if (json.error) {
              this.errorMessage = json.error.message;
              console.error({
                errorMessage: json.error.message,
              });
              throw new Error(json.error.message);
            }
            return json.result;
          });
        })
    );

    return results;
  }
}

export class CustomJsonRpcProvider extends BaseProvider {
  constructor(
    signal: AbortSignal,
    url?: ConnectionInfo | string,
    network?: Networkish
  ) {
    super(signal, url, network);
  }
}

export class CustomL2JsonRpcProvider extends Provider {
  private baseProvider: BaseProvider;

  constructor(
    signal: AbortSignal,
    url?: ConnectionInfo | string,
    network?: ethers.providers.Networkish
  ) {
    super(url, network);
    this.baseProvider = new BaseProvider(signal, url, network);
  }

  perform(method: string, params: any) {
    return this.baseProvider.perform(method, params);
  }

  send(method: string, params: any[]) {
    return this.baseProvider.send(method, params);
  }

  sendBatch(method: string, params: Array<any[]>): Promise<any[]> {
    return this.baseProvider.sendBatch(method, params);
  }
}
