-- MCP must distinguish an actively published page from a private page before
-- accepting an edit. Reuse the narrow read-only publication-status boundary;
-- publication mutations remain unavailable to the MCP role.

GRANT EXECUTE ON FUNCTION get_dashboard_publication_status(publication_target,uuid)
  TO context_use_mcp;
