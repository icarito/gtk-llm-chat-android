import { xml } from '@xmpp/client';
import type { Element } from '@xmpp/xml';
import type { DataForm, FormField, FormType } from '@/types/xmpp';

const FORM_NS = 'jabber:x:data';

function normalizeBooleanValue(value: string): string {
  return value === 'true' || value === '1' ? '1' : '0';
}

function valueToXml(field: FormField): Element[] {
  const value = field.value;
  if (value === undefined) return [];
  if (field.type === 'boolean' && typeof value === 'string') {
    return [xml('value', {}, normalizeBooleanValue(value))];
  }
  if (Array.isArray(value)) return value.map((v) => xml('value', {}, v));
  return [xml('value', {}, value)];
}

export function buildFormElement(form: DataForm): Element {
  const children: Element[] = [];

  if (form.title) children.push(xml('title', {}, form.title));
  if (form.instructions) {
    for (const instr of form.instructions) {
      children.push(xml('instructions', {}, instr));
    }
  }

  for (const field of form.fields) {
    const attrs: Record<string, string> = { var: field.var };
    if (field.type) attrs.type = field.type;
    if (field.label) attrs.label = field.label;

    const fieldEls: Element[] = [];
    if (field.desc) fieldEls.push(xml('desc', {}, field.desc));
    if (field.required) fieldEls.push(xml('required', {}));
    if (field.options && (field.type === 'list-single' || field.type === 'list-multi')) {
      for (const opt of field.options) {
        fieldEls.push(xml('option', { label: opt.label }, xml('value', {}, opt.value)));
      }
    }
    fieldEls.push(...valueToXml(field));

    children.push(xml('field', attrs, ...fieldEls));
  }

  return xml('x', { xmlns: FORM_NS, type: form.type }, ...children);
}

export function buildRequestForm(title: string, instructions: string[], fields: FormField[]): Element {
  return buildFormElement({ type: 'form', title, instructions, fields });
}

export function buildResultForm(title: string, fields: FormField[]): Element {
  return buildFormElement({ type: 'result', title, fields });
}

/** Parsea un `<x type="form|result">` a `DataForm` con los metadatos de cada campo. */
export function parseForm(xElement: Element): DataForm {
  const fields: FormField[] = [];
  for (const fieldEl of xElement.getChildren('field')) {
    const varName = fieldEl.attrs.var as string | undefined;
    if (!varName) continue;
    const values = fieldEl.getChildren('value').map((v) => v.text());
    const options = fieldEl.getChildren('option').map((o) => ({
      label: o.attrs.label as string,
      value: o.getChild('value')?.text() ?? '',
    }));
    const field: FormField = {
      var: varName,
      type: fieldEl.attrs.type as FormField['type'] | undefined,
      label: fieldEl.attrs.label as string | undefined,
      desc: fieldEl.getChild('desc')?.text(),
      required: Boolean(fieldEl.getChild('required')),
    };
    if (values.length === 1) field.value = values[0];
    else if (values.length > 1) field.value = values;
    if (options.length > 0) field.options = options;
    fields.push(field);
  }
  return {
    type: (xElement.attrs.type as FormType | undefined) ?? 'form',
    title: xElement.getChild('title')?.text(),
    instructions: xElement.getChildren('instructions').map((i) => i.text()),
    fields,
  };
}

/** Construye el form de submit a partir de uno recibido y los valores recolectados. */
export function buildSubmitForm(form: DataForm, values: Record<string, string>): DataForm {
  const fields: FormField[] = [];
  for (const field of form.fields) {
    if (field.type === 'fixed') continue;
    const raw = values[field.var] ?? (Array.isArray(field.value) ? field.value.join('\n') : field.value) ?? '';
    fields.push({ var: field.var, type: field.type, value: raw });
  }
  return { type: 'submit', fields };
}

export function parseSubmitForm(xElement: Element): Record<string, string> {
  const result: Record<string, string> = {};
  const fields = xElement.getChildren('field');
  for (const field of fields) {
    const name = field.attrs.var as string | undefined;
    if (!name) continue;
    const values = field.getChildren('value');
    if (values.length > 0) {
      result[name] = values.map((v: Element) => v.text()).join('\n');
    } else {
      result[name] = '';
    }
  }
  return result;
}

export function isFormSubmit(stanza: Element): boolean {
  const x = stanza.getChild('x', FORM_NS);
  return x !== undefined && x.attrs.type === 'submit';
}

export function isFormCancel(stanza: Element): boolean {
  const x = stanza.getChild('x', FORM_NS);
  return x !== undefined && x.attrs.type === 'cancel';
}
