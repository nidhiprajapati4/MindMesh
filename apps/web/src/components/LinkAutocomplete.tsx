'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { api, linkKey, type Note, type NoteList } from '@/lib/api';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  /** The note being edited, left out of the suggestions. */
  excludeId?: string;
  /** Off for snippets, where [[ is code. */
  linking: boolean;
};

type Option = { title: string; isNew: boolean };
const MAX_OPTIONS = 6;

/** The unfinished "[[query" just before the caret, if any. */
function openLink(text: string, caret: number) {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('[[');
  if (start < 0) return null;
  const query = before.slice(start + 2);
  if (/[[\]\n]/.test(query) || query.length > 200) return null;
  return { start, query };
}

/**
 * A textarea that suggests note titles after "[[": arrow keys choose, Enter or Tab inserts
 * "[[Title]]", Esc closes the list. Titles come from the existing keyword search.
 */
export function LinkTextarea({ value, onChange, excludeId, linking, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [link, setLink] = useState<{ start: number; query: string } | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [active, setActive] = useState(0);

  const update = (text: string, caret: number) => setLink(linking ? openLink(text, caret) : null);

  useEffect(() => {
    if (!link) return setOptions([]);
    let live = true;
    const q = link.query.trim();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: String(MAX_OPTIONS + 1), ...(q ? { q } : {}) });
      api<NoteList>(`/api/notes?${params}`)
        .then(({ items }) => {
          if (!live) return;
          const titles = [...new Set(items.filter((n: Note) => n._id !== excludeId && n.title).map((n) => n.title))].slice(0, MAX_OPTIONS);
          const next: Option[] = titles.map((title) => ({ title, isNew: false }));
          if (q && !titles.some((t) => linkKey(t) === linkKey(q))) next.push({ title: q, isNew: true });
          setOptions(next);
          setActive(0);
        })
        .catch(() => live && setOptions([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [link, excludeId]);

  const insert = (title: string) => {
    const el = ref.current;
    if (!el || !link) return;
    const caret = el.selectionStart;
    const after = value.slice(caret).replace(/^\]\]/, ''); // the user may already have typed the closing brackets
    const text = `${value.slice(0, link.start)}[[${title}]]`;
    onChange(text + after);
    setLink(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const open = !!link && options.length > 0;
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
      e.preventDefault();
      insert(options[active].title);
    } else if (e.key === 'Escape') {
      // Close the list only; the editor's own Esc handler must not close the dialog.
      e.preventDefault();
      e.stopPropagation();
      setLink(null);
    }
  };

  return (
    <div className="relative">
      <textarea
        {...rest}
        ref={ref}
        value={value}
        role={linking ? 'combobox' : undefined}
        aria-autocomplete={linking ? 'list' : undefined}
        aria-expanded={linking ? open : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          update(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => update(value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setLink(null), 150)}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Link to a note"
          className="absolute inset-x-2 bottom-2 z-10 max-h-60 overflow-y-auto rounded border border-line bg-white py-1 text-sm shadow-lg">
          {options.map((o, i) => (
            <li key={`${o.isNew}-${o.title}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              className={`cursor-pointer px-3 py-1.5 ${i === active ? 'bg-paper' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the textarea
                insert(o.title);
              }}
              onMouseEnter={() => setActive(i)}>
              {o.isNew ? <span className="text-muted">Link to a new note “<span className="text-ink">{o.title}</span>”</span> : o.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
