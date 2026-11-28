/**
 * Customise's sections, each a page over the SDK's own methods (docs/CODING-APP.md §4 "Customise", step 4). Importing
 * this registers every one in place of customise.ts's empty state for its label, in the order customise.ts lists them.
 */
import "./customise-models";
import "./customise-mcp";
import "./customise-skills";
import "./customise-plugins";
import "./customise-agents";
import "./customise-instructions";
import "./customise-hooks";
import "./customise-permissions";
import "./customise-sandbox";
import "./customise-schedules";
import "./customise-usage";
// The person's defaults and a project's settings, a session's own options (docs/CODING-APP.md §8).
import "./customise-defaults";
import "./customise-session";
import "./customise-storage";
// The companion's state, with a way to its switch in settings (not an SDK page: docs/CODING-APP.md §5).
import "./customise-companion";
