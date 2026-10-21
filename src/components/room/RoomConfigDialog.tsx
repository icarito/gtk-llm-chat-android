import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Colors } from '@/constants/theme';
import type { DataForm, FormField } from '@/types/xmpp';
import type { ConfigField } from '@/xmpp/xep/muc';
interface Props {
  visible: boolean;
  loadForm: () => Promise<DataForm>;
  onSubmit: (fields: ConfigField[]) => Promise<void>;
  onClose: () => void;
}

function fieldValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join('\n');
  return value ?? '';
}

function collectValues(field: FormField, value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value ? value.split('\n') : [];
  return [];
}

function buildFields(form: DataForm, values: Record<string, string | string[]>): ConfigField[] {
  const out: ConfigField[] = [];
  for (const f of form.fields) {
    if (!f.var) continue;
    out.push({ var: f.var, type: f.type, values: collectValues(f, f.var in values ? values[f.var] : f.value) });
  }
  return out;
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function FieldEditor({ field, value, onChange }: { field: FormField; value: string | string[] | undefined; onChange: (v: string | string[]) => void }) {
  switch (field.type) {
    case 'boolean':
      return (
        <View style={styles.boolRow}>
          <Switch
            value={fieldValue(value) === '1'}
            onValueChange={(v) => onChange(v ? '1' : '0')}
            trackColor={{ true: Colors.primary, false: Colors.surfaceBorder }}
            thumbColor={Colors.surface}
          />
          <Text style={styles.boolText}>{field.label || field.var}</Text>
        </View>
      );
    case 'list-single': {
      const current = fieldValue(value);
      return (
        <View style={styles.chips}>
          {(field.options ?? []).map((o) => (
            <Chip key={o.value} label={o.label || o.value} selected={current === o.value} onPress={() => onChange(o.value)} />
          ))}
        </View>
      );
    }
    case 'list-multi': {
      const arr = Array.isArray(value) ? value : value ? [value] : [];
      return (
        <View style={styles.chips}>
          {(field.options ?? []).map((o) => (
            <Chip
              key={o.value}
              label={o.label || o.value}
              selected={arr.includes(o.value)}
              onPress={() => onChange(arr.includes(o.value) ? arr.filter((v) => v !== o.value) : [...arr, o.value])}
            />
          ))}
        </View>
      );
    }
    case 'text-multi':
    case 'jid-multi':
      return (
        <TextInput
          style={[styles.input, styles.multiline]}
          value={fieldValue(value)}
          onChangeText={(t) => onChange(t)}
          multiline
          placeholderTextColor={Colors.textDim}
        />
      );
    case 'fixed':
      return <Text style={styles.fixed}>{fieldValue(value)}</Text>;
    case 'hidden':
      return null;
    default:
      return (
        <TextInput
          style={styles.input}
          value={fieldValue(value)}
          onChangeText={(t) => onChange(t)}
          placeholderTextColor={Colors.textDim}
        />
      );
  }
}

export default function RoomConfigDialog({ visible, loadForm, onSubmit, onClose }: Props) {
  const [form, setForm] = useState<DataForm | null>(null);
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setForm(null);
    setValues({});
    setError(null);
    setLoading(true);
    loadForm()
      .then((f) => {
        if (!alive) return;
        const initial: Record<string, string | string[]> = {};
        for (const field of f.fields) {
          if (field.value !== undefined) initial[field.var] = field.value;
        }
        setForm(f);
        setValues(initial);
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [visible, loadForm]);

  const setValue = useCallback((v: string, val: string | string[]) => {
    setValues((prev) => ({ ...prev, [v]: val }));
  }, []);

  const submit = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await onSubmit(buildFields(form, values));
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>Configuración de la sala</Text>
            <Pressable onPress={onClose}>
              <Text style={styles.close}>Cerrar</Text>
            </Pressable>
          </View>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Text style={styles.error}>{error}</Text>
            </View>
          ) : form ? (
            <>
              <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
                {form.title ? <Text style={styles.formTitle}>{form.title}</Text> : null}
                {form.instructions?.map((i, idx) => (
                  <Text key={idx} style={styles.instructions}>{i}</Text>
                ))}
                {form.fields.map((field, idx) => {
                  if (field.type === 'hidden') return null;
                  return (
                    <View key={field.var || idx} style={styles.fieldRow}>
                      {field.type !== 'boolean' && field.label ? (
                        <Text style={styles.fieldLabel}>
                          {field.label}
                          {field.required ? ' *' : ''}
                        </Text>
                      ) : null}
                      {field.desc ? <Text style={styles.desc}>{field.desc}</Text> : null}
                      <FieldEditor field={field} value={values[field.var]} onChange={(v) => setValue(field.var, v)} />
                    </View>
                  );
                })}
              </ScrollView>
              <View style={styles.footer}>
                <Pressable style={styles.cancelBtn} onPress={onClose}>
                  <Text style={styles.cancelText}>Cancelar</Text>
                </Pressable>
                <Pressable style={styles.saveBtn} onPress={submit} disabled={saving}>
                  {saving ? <ActivityIndicator color={Colors.background} /> : <Text style={styles.saveText}>Enviar</Text>}
                </Pressable>
              </View>
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000A', justifyContent: 'center', padding: 16 },
  card: { backgroundColor: Colors.surface, borderRadius: 14, maxHeight: '85%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder },
  title: { color: Colors.text, fontSize: 16, fontWeight: '700' },
  close: { color: Colors.muted, fontSize: 14 },
  center: { padding: 40, alignItems: 'center' },
  error: { color: Colors.error, textAlign: 'center' },
  body: { padding: 16 },
  formTitle: { color: Colors.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
  instructions: { color: Colors.muted, fontSize: 13, marginBottom: 8 },
  fieldRow: { marginBottom: 16 },
  fieldLabel: { color: Colors.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
  desc: { color: Colors.muted, fontSize: 12, marginBottom: 6 },
  input: { backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 8, padding: 10, color: Colors.text, fontSize: 14 },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  boolRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  boolText: { color: Colors.text, fontSize: 14, flexShrink: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: Colors.surfaceBorder, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.inputBackground },
  chipSelected: { borderColor: Colors.primary, backgroundColor: Colors.primary },
  chipText: { color: Colors.text, fontSize: 13 },
  chipTextSelected: { color: Colors.background, fontWeight: '700' },
  fixed: { color: Colors.muted, fontSize: 14 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, padding: 16, borderTopWidth: 1, borderTopColor: Colors.surfaceBorder },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  cancelText: { color: Colors.muted, fontSize: 15 },
  saveBtn: { backgroundColor: Colors.primary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, minWidth: 96, alignItems: 'center' },
  saveText: { color: Colors.background, fontWeight: '700', fontSize: 15 },
});
