// C13 tool definition for "Unir PDF". This module is the page's entry for the tool: it starts it.
import { outputName } from '../filename.js';
import { bootTool } from '../tool-controller.js';

const definition = {
  accepts: ['pdf'],
  acceptAttr: 'application/pdf,.pdf',
  wrongType: 'WRONG_TYPE_PDF',
  minFiles: 2,
  op: 'merge',
  outputName: (entries) => outputName('merge', entries[0].name, entries.length),
  strings: 'merge',
};

bootTool(definition);
