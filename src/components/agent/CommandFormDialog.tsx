import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Colors } from '@/constants/theme';
import type { DataForm, FormField } from '@/types/xmpp';
import { buildSubmitForm } from '@/xmpp/xep-0004';

interface CommandFormDialogProps {
  visible: boolean;
  title: string;
  form: DataForm;
  busy?: boolean;
  onSubmit: (form: DataForm) => void;
  onCancel: () => void;
}

function fieldDefault(f: FormField): string {
  if (Array.isArray(f.value)) return f.value.join('\n');
  return f.value ?? '';
}

function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string;
  onChange: (next: string) => void;
}) {
  const label = field.label ?? field.var;

  if (field.type === 'boolean') {
    return (
      <View style={styles.field}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>{label}</Text>
          <Switch
            value={value === '1' || value === 'true'}
            onValueChange={(next) => onChange(next ? '1' : '0')}
          />
        </View>
        {field.desc ? <Text style={styles.desc}>{field.desc}</Text> : null}
      </View>
    );
  }

  if (field.type === 'list-single' && field.options) {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.options}>
          {field.options.map((option) => {
            const selected = value === option.value;
            return (
              <Pressable
                key={option.value}
                style={[styles.option, selected && styles.optionSelected]}
                onPress={() => onChange(option.value)}
                accessibilityRole="button"
              >
                <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {field.desc ? <Text style={styles.desc}>{field.desc}</Text> : null}
      </View>
    );
  }

  if (field.type === 'list-multi' && field.options) {
    const active = value ? value.split('\n').filter(Boolean) : [];
    const toggle = (optionValue: string) => {
      const next = active.includes(optionValue)
        ? active.filter((item) => item !== optionValue)
        : [...active, optionValue];
      onChange(next.join('\n'));
    };
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.options}>
          {field.options.map((option) => {
            const selected = active.includes(option.value);
            return (
              <Pressable
                key={option.value}
                style={[styles.option, selected && styles.optionSelected]}
                onPress={() => toggle(option.value)}
                accessibilityRole="button"
              >
                <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {field.desc ? <Text style={styles.desc}>{field.desc}</Text> : null}
      </View>
    );
  }

  const multiline = field.type === 'text-multi';
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        placeholder={field.desc}
        placeholderTextColor={Colors.textDim}
      />
      {field.desc ? <Text style={styles.desc}>{field.desc}</Text> : null}
    </View>
  );
}

export function CommandFormDialog({ visible, title, form, busy, onSubmit, onCancel }: CommandFormDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const field of form.fields) init[field.var] = fieldDefault(field);
    return init;
  });

  const setValue = (name: string, next: string) => {
    setValues((prev) => ({ ...prev, [name]: next }));
  };

  const editable = form.fields.filter((field) => field.type !== 'fixed');
  const missingRequired = editable.some((field) => field.required && !(values[field.var] ?? '').trim());
  const canSubmit = !busy && !missingRequired;

  const submit = () => onSubmit(buildSubmitForm(form, values));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
            <Text style={styles.title}>{title}</Text>
            {form.instructions?.map((instruction, index) => (
              <Text key={index} style={styles.instructions}>{instruction}</Text>
            ))}
            {editable.map((field) => (
              <FieldEditor
                key={field.var}
                field={field}
                value={values[field.var] ?? ''}
                onChange={(next) => setValue(field.var, next)}
              />
            ))}
          </ScrollView>
          <View style={styles.actions}>
            <Pressable style={[styles.button, styles.buttonCancel]} onPress={onCancel} disabled={busy}>
              <Text style={styles.buttonCancelText}>Cancelar</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.buttonPrimary]} onPress={submit} disabled={!canSubmit}>
              <Text style={styles.buttonPrimaryText}>{busy ? 'Enviando…' : 'Enviar'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: Colors.surface, borderRadius: 16, padding: 16, maxHeight: '80%' },
  scroll: { gap: 4 },
  title: { color: Colors.text, fontSize: 17, fontWeight: '700', marginBottom: 4 },
  instructions: { color: Colors.muted, fontSize: 13, marginBottom: 4 },
  field: { marginTop: 10, gap: 4 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  label: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  desc: { color: Colors.textDim, fontSize: 12 },
  input: {
    backgroundColor: Colors.inputBackground,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: 10,
    color: Colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.inputBackground,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  optionSelected: { borderColor: Colors.primary },
  optionText: { color: Colors.text, fontSize: 13 },
  optionTextSelected: { color: Colors.primary, fontWeight: '700' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  button: {
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 90,
  },
  buttonCancel: { backgroundColor: Colors.inputBackground, borderWidth: 1, borderColor: Colors.surfaceBorder },
  buttonCancelText: { color: Colors.text, fontSize: 14 },
  buttonPrimary: { backgroundColor: Colors.primary },
  buttonPrimaryText: { color: Colors.background, fontSize: 14, fontWeight: '700' },
});
