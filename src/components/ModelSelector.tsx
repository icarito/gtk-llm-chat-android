import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import type { ModelInfo, ModelGroup } from '@/types';
import { fetchModels } from '@/api/client';

interface ModelSelectorProps {
  selectedModelId?: string;
  onSelect: (modelId: string) => void;
}

export function ModelSelector({ selectedModelId, onSelect }: ModelSelectorProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await fetchModels();
        if (!cancelled) setModels(data);
      } catch {
        // Silently fail — settings will show empty
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const grouped: ModelGroup[] = React.useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    models.forEach((m) => {
      const provider = m.provider || 'Unknown';
      if (!map.has(provider)) map.set(provider, []);
      map.get(provider)!.push(m);
    });
    return Array.from(map.entries()).map(([provider, providerModels]) => ({
      provider,
      models: providerModels,
    }));
  }, [models]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="small" color="#4FC3F7" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {grouped.map((group) => (
        <View key={group.provider}>
          <TouchableOpacity
            style={styles.providerHeader}
            onPress={() =>
              setExpandedProvider(
                expandedProvider === group.provider ? null : group.provider,
              )
            }
          >
            <Text style={styles.providerName}>{group.provider}</Text>
            <Text style={styles.providerCount}>{group.models.length} models</Text>
          </TouchableOpacity>
          {expandedProvider === group.provider && (
            <FlatList
              data={group.models}
              keyExtractor={(item) => item.model_id}
              scrollEnabled={false}
              renderItem={({ item }) => {
                const isSelected = item.model_id === selectedModelId;
                return (
                  <TouchableOpacity
                    style={[styles.modelItem, isSelected && styles.modelItemSelected]}
                    onPress={() => onSelect(item.model_id)}
                  >
                    <Text style={styles.modelName}>{item.model_id}</Text>
                    {isSelected && <Text style={styles.checkmark}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
  },
  loading: {
    padding: 16,
    alignItems: 'center',
  },
  providerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#1E2A3A',
  },
  providerName: {
    color: '#4FC3F7',
    fontSize: 14,
    fontWeight: '600',
  },
  providerCount: {
    color: '#607589',
    fontSize: 12,
  },
  modelItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: '#10161F',
    marginBottom: 2,
    borderRadius: 6,
  },
  modelItemSelected: {
    backgroundColor: '#1A2A3A',
    borderWidth: 1,
    borderColor: '#4FC3F7',
  },
  modelName: {
    color: '#D0D8E0',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  checkmark: {
    color: '#4FC3F7',
    fontSize: 16,
    fontWeight: '700',
  },
});
