import { NodeTools }      from './NodeTools.js';
import { EdgeTools }      from './EdgeTools.js';
import { SearchTool }     from './SearchTool.js';
import { DreamingTool }   from './DreamingTool.js';
import { BootstrapTool }  from './BootstrapTool.js';

export const ToolDefinitions = [...NodeTools, ...EdgeTools, SearchTool, DreamingTool, BootstrapTool];
