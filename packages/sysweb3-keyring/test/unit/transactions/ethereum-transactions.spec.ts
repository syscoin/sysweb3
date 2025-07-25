import { encrypt } from 'eth-sig-util';

import { KeyringManager, KeyringAccountType } from '../../../src';
import { FAKE_PASSWORD, PEACE_SEED_PHRASE } from '../../helpers/constants';
import { setupMocks } from '../../helpers/setup';
import { INetworkType } from '@pollum-io/sysweb3-network';

describe('Ethereum Transactions', () => {
  let keyringManager: KeyringManager;
  let mockVaultStateGetter: jest.Mock;
  let currentVaultState: any;

  beforeEach(async () => {
    setupMocks();
    // Set up vault-keys that would normally be created by Pali's MainController
    await setupTestVault(FAKE_PASSWORD);

    // Set up EVM vault state
    currentVaultState = createMockVaultState({
      activeAccountId: 0,
      activeAccountType: KeyringAccountType.HDAccount,
      networkType: INetworkType.Ethereum,
      chainId: 1,
    });
    mockVaultStateGetter = jest.fn(() => currentVaultState);

    keyringManager = await KeyringManager.createInitialized(
      PEACE_SEED_PHRASE,
      FAKE_PASSWORD,
      mockVaultStateGetter
    );
  });

  describe('Transaction Signing', () => {
    it('should sign a transaction', async () => {
      const tx = {
        from: keyringManager.getActiveAccount().activeAccount.address,
        to: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', // Valid checksummed address
        value: '0x0',
        gasLimit: '0x5208',
        maxFeePerGas: '0x4a817c800', // 20 gwei
        maxPriorityFeePerGas: '0x77359400', // 2 gwei
        nonce: '0x0',
        chainId: 1,
      };

      const result =
        await keyringManager.ethereumTransaction.sendFormattedTransaction(tx);
      expect(result).toBeDefined();
      expect(result.hash).toBeDefined();
    });

    it('should get recommended nonce', async () => {
      const nonce =
        await keyringManager.ethereumTransaction.getRecommendedNonce(
          keyringManager.getActiveAccount().activeAccount.address
        );
      expect(nonce).toBe(0); // Updated to match mock return value
    });

    it('should get fee data with dynamic max priority fee', async () => {
      const feeData =
        await keyringManager.ethereumTransaction.getFeeDataWithDynamicMaxPriorityFeePerGas();
      expect(feeData).toBeDefined();
      expect(feeData.maxFeePerGas).toBeDefined();
      expect(feeData.maxPriorityFeePerGas).toBeDefined();
    });

    it('should estimate gas limit', async () => {
      const tx = {
        from: keyringManager.getActiveAccount().activeAccount.address,
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f8b2bc',
        value: '0x0',
        chainId: 1,
        maxFeePerGas: '0x4a817c800',
        maxPriorityFeePerGas: '0x77359400',
      };

      const gasLimit = await keyringManager.ethereumTransaction.getTxGasLimit(
        tx
      );
      expect(gasLimit).toBeDefined();
      expect(gasLimit._isBigNumber).toBe(true);
    });
  });

  describe('Message Signing', () => {
    it('should sign a message with eth_sign', async () => {
      const message =
        '0x' + Buffer.from('Hello World').toString('hex').padStart(64, '0'); // 32-byte hash
      const signature = await keyringManager.ethereumTransaction.ethSign([
        keyringManager.getActiveAccount().activeAccount.address,
        message,
      ]);

      expect(signature).toBeDefined();
      expect(signature.startsWith('0x')).toBe(true);
      expect(signature.length).toBe(132); // 0x + 130 hex chars
    });

    it('should sign a personal message', async () => {
      const message =
        '0x4578616d706c652060706572736f6e616c5f7369676e60206d657373616765';
      const signature =
        await keyringManager.ethereumTransaction.signPersonalMessage([
          message,
          keyringManager.getActiveAccount().activeAccount.address,
        ]);

      expect(signature).toBeDefined();
      expect(signature.startsWith('0x')).toBe(true);
    });

    it('should verify personal message signature', () => {
      const message = 'Example `personal_sign` message';
      const signature =
        '0x1e4c47c96d285648db99bf2bdf691aae354d2beb80ceeeaaffa643d37900bf510ea0f5cd06518fcfc67e607898308de1497b6036ccd343ab17e3f59eb87567e41c';
      const address = '0x6a92eF94F6Db88098625a30396e0fde7255E97d5';

      const recovered =
        keyringManager.ethereumTransaction.verifyPersonalMessage(
          message,
          signature
        );

      expect(recovered.toLowerCase()).toBe(address.toLowerCase());
    });

    it('should parse personal message from hex', () => {
      const hexMessage =
        '0x4578616d706c652060706572736f6e616c5f7369676e60206d657373616765';
      const parsed =
        keyringManager.ethereumTransaction.parsePersonalMessage(hexMessage);

      expect(parsed).toBe('Example `personal_sign` message');
    });
  });

  describe('Typed Data Signing', () => {
    const typedDataV1 = [
      {
        type: 'string',
        name: 'Message',
        value: 'Hi, Alice!',
      },
      {
        type: 'uint32',
        name: 'A number',
        value: '1337',
      },
    ];

    const typedDataV3V4 = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        Person: [
          { name: 'name', type: 'string' },
          { name: 'wallet', type: 'address' },
        ],
        Mail: [
          { name: 'from', type: 'Person' },
          { name: 'to', type: 'Person' },
          { name: 'contents', type: 'string' },
        ],
      },
      primaryType: 'Mail',
      domain: {
        name: 'Ether Mail',
        version: '1',
        chainId: 1,
        verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
      },
      message: {
        from: {
          name: 'Cow',
          wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826',
        },
        to: {
          name: 'Bob',
          wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
        },
        contents: 'Hello, Bob!',
      },
    };

    it('should sign typed data V1', async () => {
      const signature = await keyringManager.ethereumTransaction.signTypedData(
        keyringManager.getActiveAccount().activeAccount.address,
        typedDataV1,
        'V1'
      );

      expect(signature).toBeDefined();
      expect(signature.startsWith('0x')).toBe(true);
    });

    it('should sign typed data V3', async () => {
      const signature = await keyringManager.ethereumTransaction.signTypedData(
        keyringManager.getActiveAccount().activeAccount.address,
        typedDataV3V4,
        'V3'
      );

      expect(signature).toBeDefined();
      expect(signature.startsWith('0x')).toBe(true);
    });

    it('should sign typed data V4', async () => {
      const signature = await keyringManager.ethereumTransaction.signTypedData(
        keyringManager.getActiveAccount().activeAccount.address,
        typedDataV3V4,
        'V4'
      );

      expect(signature).toBeDefined();
      expect(signature.startsWith('0x')).toBe(true);
    });

    it('should verify typed signature', () => {
      const signature =
        '0x6fd4f93623d151b487656cd3a0aaaec16aee409c353bad7c1f8eecbbab07b06f51ac8be73d7a2d4bba579505aff7c5a62f91141fee75ff2cbb0c111dcfe589c01b';
      const recovered = keyringManager.ethereumTransaction.verifyTypedSignature(
        typedDataV1,
        signature,
        'V1'
      );

      expect(recovered.toLowerCase()).toBe(
        '0x6a92eF94F6Db88098625a30396e0fde7255E97d5'.toLowerCase()
      );
    });
  });

  describe('Encryption/Decryption', () => {
    it('should get encrypted public key', () => {
      const pubKey = keyringManager.ethereumTransaction.getEncryptedPubKey();

      expect(pubKey).toBeDefined();
      expect(pubKey).toBe('KxnDhpzCBCj23z8ZcMr/+2yibUVUa/87wS+7uw59dyY='); // Updated to match actual generated key
    });

    it('should decrypt message', () => {
      // Create a proper roundtrip test: encrypt then decrypt
      const originalMessage = 'Hello, World!';

      // Get the public key for encryption
      const encryptionPublicKey =
        keyringManager.ethereumTransaction.getEncryptedPubKey();
      expect(encryptionPublicKey).toBeDefined();

      // Use eth-sig-util to encrypt the message
      const encryptedData = encrypt(
        encryptionPublicKey,
        { data: originalMessage },
        'x25519-xsalsa20-poly1305'
      );

      // Convert encrypted data to the hex format that decryptMessage expects
      const encryptedHex = Buffer.from(JSON.stringify(encryptedData)).toString(
        'hex'
      );

      // Now decrypt using decryptMessage
      const decrypted = keyringManager.ethereumTransaction.decryptMessage([
        encryptedHex,
        keyringManager.getActiveAccount().activeAccount.address,
      ]);

      expect(decrypted).toBe(originalMessage);
    });
  });

  describe('Account Management', () => {
    it('should import account from private key', () => {
      const privateKey =
        '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
      const account =
        keyringManager.ethereumTransaction.importAccount(privateKey);

      expect(account.address).toBe(
        '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23'
      );
      expect(account.privateKey).toBe(privateKey);
    });

    it('should get account balance', async () => {
      const balance = await keyringManager.ethereumTransaction.getBalance(
        keyringManager.getActiveAccount().activeAccount.address
      );

      expect(balance).toBe(1); // Updated to match mock return value
    });
  });

  describe('Utility Functions', () => {
    it('should convert to BigNumber', () => {
      const value = 1000;
      const bigNumber = keyringManager.ethereumTransaction.toBigNumber(value);

      expect(bigNumber._isBigNumber).toBe(true);
      expect(bigNumber._hex).toBe('0x03e8'); // Updated to match actual format
    });
  });

  describe('Multiple Account Signing', () => {
    it('should sign with different accounts', async () => {
      // Add a second account
      const account2 = await keyringManager.addNewAccount();

      // Update vault state with the new account (in stateless keyring, this would be done by Pali/Redux)
      currentVaultState.accounts[KeyringAccountType.HDAccount][account2.id] = {
        id: account2.id,
        address: account2.address,
        xpub: account2.xpub,
        xprv: account2.xprv,
        label: account2.label,
        balances: account2.balances,
        isImported: account2.isImported,
        isTrezorWallet: account2.isTrezorWallet,
        isLedgerWallet: account2.isLedgerWallet,
      };

      // Sign with first account
      const signature1 =
        await keyringManager.ethereumTransaction.signPersonalMessage([
          '0x48656c6c6f',
          keyringManager.getActiveAccount().activeAccount.address,
        ]);

      // Switch to second account
      currentVaultState.activeAccount = {
        id: account2.id,
        type: KeyringAccountType.HDAccount,
      };

      // Sign with second account
      const signature2 =
        await keyringManager.ethereumTransaction.signPersonalMessage([
          '0x48656c6c6f',
          account2.address,
        ]);

      // Signatures should be different
      expect(signature1).not.toBe(signature2);
    });
  });

  describe('Error Handling', () => {
    it('should handle transaction parameters', async () => {
      const tx = {
        from: keyringManager.getActiveAccount().activeAccount.address,
        to: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', // Valid checksummed address
        value: '0x0',
        chainId: 1,
        maxFeePerGas: '0x4a817c800',
        maxPriorityFeePerGas: '0x77359400',
        gasLimit: '0x5208',
      };

      const result =
        await keyringManager.ethereumTransaction.sendFormattedTransaction(tx);
      expect(result).toBeDefined();
      expect(result.hash).toBeDefined();
    });

    it('should handle signing with locked wallet', async () => {
      keyringManager.lockWallet();

      await expect(async () => {
        await keyringManager.ethereumTransaction.signPersonalMessage([
          '0x48656c6c6f',
          '0x0000000000000000000000000000000000000000',
        ]);
      }).rejects.toThrow();
    });
  });
});
