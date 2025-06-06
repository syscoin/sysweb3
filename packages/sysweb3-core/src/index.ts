import { parseJsonRecursively } from './utils';

interface IStateStorageClient {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface IStateStorageDb {
  deleteItem(key: string): void;
  get(key: string): JSON;
  set(key: string, value: any): void;
  setClient(client?: IStateStorageClient): void;
  setPrefix(prefix: string): void;
}

export interface IKeyValueDb {
  deleteItem(key: string): void;
  get(key: string): any;
  set(key: string, value: any): void;
  setClient(client?: IStateStorageClient): void;
  setPrefix(prefix: string): void;
}

declare let window: any;
const defaultStorage =
  typeof window !== 'undefined' ? window.localStorage : undefined;

const StateStorageDb = (
  storageClient: any | undefined = defaultStorage
): IKeyValueDb => {
  let keyPrefix = 'sysweb3-';

  const setClient = (client?: IStateStorageClient) => {
    storageClient = client || defaultStorage;
  };

  const setPrefix = (prefix: string) => {
    if (!prefix) {
      prefix = 'sysweb3-';
    } else if (prefix.charAt(prefix.length - 1) !== '-') {
      prefix += '-';
    }
    keyPrefix = prefix;
  };

  const set = (key: string, value: any) => {
    if (!storageClient) return;

    if ('set' in storageClient) {
      storageClient.set({ [keyPrefix + key]: value });
      return;
    }

    storageClient.setItem(keyPrefix + key, JSON.stringify(value));
  };

  const get = async (key: string): Promise<any> => {
    if (!storageClient) return;

    if ('get' in storageClient) {
      const value = await storageClient.get(keyPrefix + key);
      if (value) {
        const result = parseJsonRecursively(value);
        return result[keyPrefix + key];
      }
      return {};
    }

    const value = storageClient.getItem(keyPrefix + key);
    if (value) {
      return JSON.parse(value);
    }
  };

  const deleteItem = (key: string) => {
    if (!storageClient) return;
    if ('remove' in storageClient) {
      storageClient.remove(keyPrefix + key);
      return;
    }

    storageClient.removeItem(keyPrefix + key);
  };

  return {
    setClient,
    setPrefix,
    set,
    get,
    deleteItem,
  };
};

const MemoryStorageClient = (): IStateStorageClient => {
  const memory: any = {};

  const setItem = (key: string, value: any) => {
    memory[key] = value;
  };

  const getItem = (key: string): any => memory[key];

  const removeItem = (key: string) => {
    memory[key] = null;
  };

  return {
    setItem,
    getItem,
    removeItem,
  };
};

const CrossPlatformDi = () => {
  //======================
  //= State Storage =
  //======================
  const stateStorageDb: IStateStorageDb = StateStorageDb(MemoryStorageClient());

  const getStateStorageDb = (): IKeyValueDb => stateStorageDb;

  return {
    getStateStorageDb,
  };
};

const SysWeb3Di = () => {
  const crossPlatformDi = CrossPlatformDi();
  const getStateStorageDb = (): IKeyValueDb =>
    crossPlatformDi.getStateStorageDb();

  return {
    getStateStorageDb,
  };
};

export const sysweb3Di = SysWeb3Di();
