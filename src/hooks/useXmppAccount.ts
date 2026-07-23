import { useState, useEffect, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { XmppAccountConfig } from '@/types/xmpp';

const ACCOUNT_KEY = '@gtk_llm_chat:xmpp_account';

async function safeGet(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ACCOUNT_KEY, {
      requireAuthentication: false,
    });
  } catch {
    try {
      return await AsyncStorage.getItem(ACCOUNT_KEY);
    } catch {
      return null;
    }
  }
}

async function safeSet(value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(ACCOUNT_KEY, value, {
      requireAuthentication: false,
      keychainAccessible: SecureStore.ALWAYS,
    });
  } catch {
    try {
      await AsyncStorage.setItem(ACCOUNT_KEY, value);
    } catch {
      // silent fail
    }
  }
}

async function safeDelete(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(ACCOUNT_KEY, {
      requireAuthentication: false,
    });
  } catch {
    try {
      await AsyncStorage.removeItem(ACCOUNT_KEY);
    } catch {
      // silent fail
    }
  }
}

export function useXmppAccount() {
  const [account, setAccount] = useState<XmppAccountConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    safeGet()
      .then((data) => {
        if (data) {
          const parsed = JSON.parse(data) as XmppAccountConfig;
          // OMEMO is the safe default for existing installations created
          // before the setting existed. The UI still allows opting out.
          setAccount({ ...parsed, omemoEnabled: parsed.omemoEnabled ?? true });
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const saveAccount = useCallback(async (config: XmppAccountConfig) => {
    await safeSet(JSON.stringify(config));
    setAccount(config);
  }, []);

  const deleteAccount = useCallback(async () => {
    await safeDelete();
    setAccount(null);
  }, []);

  return { account, loading, saveAccount, deleteAccount };
}
