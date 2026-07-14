import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Conversation } from '@/types';

interface ConversationCardProps {
  item: Conversation;
  onPress: (id: string) => void;
  onRename: (id: string, currentTitle: string) => void;
  onDelete: (id: string) => void;
}

export function ConversationCard({ item, onPress, onRename, onDelete }: ConversationCardProps) {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onPress(item.id)}
      onLongPress={() => onRename(item.id, item.name)}
      activeOpacity={0.7}
    >
      <View style={styles.cardContent}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.name || 'Untitled'}
          </Text>
          <Text style={styles.cardModel}>{item.model}</Text>
        </View>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => onDelete(item.id)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.deleteText}>×</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#131822',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#1E2A3A',
  },
  cardContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardHeader: {
    flex: 1,
  },
  cardTitle: {
    color: '#E0E0E0',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  cardModel: {
    color: '#4FC3F7',
    fontSize: 12,
  },
  deleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  deleteText: {
    color: '#607589',
    fontSize: 20,
    fontWeight: '600',
  },
});
