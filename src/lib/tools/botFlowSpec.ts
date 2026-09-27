/** Tool description for updateBotFlow — the graph format kitchenasty's flow engine validates. */
export const BOT_FLOW_GRAPH_SPEC = `Replaces a Bot Studio flow's entire node/edge graph — this is how you actually build or change what a flow does. Design it yourself as JSON:
Nodes: { id, kind, position: {x,y}, data: {kind, label, ...kind-specific fields} }. Every flow needs exactly one "start" node and at least one "end" node, and every node must be reachable by an edge from start.
Block kinds and their data fields:
- message/image/video: text (and url for image/video). Use {{variableName}} in text to insert a previously captured value.
- choice: text (the question) + options: [{id, label}] — routes onward per-option via matching edge.handle.
- textInput/numberInput/emailInput/phoneInput/dateInput/ratingInput/fileInput: text (the question) + variable (name to store the answer under) + placeholder.
- aiCapture: text (the question) + variable — AI parses the customer's free-text reply into structured menu items matched against the REAL menu (use this for "what would you like to order", never plain textInput for that).
- condition: rules: [{id, variable, operator: equals|notEquals|contains|greaterThan|lessThan|isSet|isEmpty, value}] + matchMode: all|any — routes via edge.handle matching the rule id, or edge.handle "else".
- setVariable: setVar + setValue (supports {{}} interpolation).
- webhook: method, webhookUrl ("internal://live-orders" creates a REAL order using a "cartItems" variable an aiCapture block produced, plus "phone" and "fulfilment" variables if present) + responseVar (name to store the result — the real order number — under).
- handoff: text (message shown while handing off) + handoffSummary (context for the human agent).
- jump: targetNodeId.
- end: text (closing message).
Edges: { id, source, target, handle? (for choice options or condition rule ids / "else"), label? }.
The response includes "issues": string[] from validation — if non-empty, fix them and call updateBotFlow again before telling the owner it's ready.`;
