import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';

/**
 * The document schema, shared by the editor in the browser and the collaboration server so both agree on exactly
 * which content can exist. `history` is off because collaboration brings its own undo.
 */
export const docExtensions = () => [
  StarterKit.configure({ history: false, heading: { levels: [1, 2, 3, 4] } }),
  Underline,
  Link.configure({ openOnClick: false, autolink: false, protocols: ['http', 'https', 'mailto'] }),
  Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
  TaskList, TaskItem.configure({ nested: true }),
];

import { getSchema } from '@tiptap/core';
export const docSchema = () => getSchema(docExtensions());
