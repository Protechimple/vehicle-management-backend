// The Super Admin activity views read the audit log by time: per organization, per action, and across all of them.
async function up({ context: queryInterface }) {
  await queryInterface.addIndex('audit_logs', ['tenant_id', 'created_at'], {
    name: 'ix_audit_logs_tenant_created',
  });
  await queryInterface.addIndex('audit_logs', ['tenant_id', 'action', 'created_at'], {
    name: 'ix_audit_logs_tenant_action_created',
  });
  await queryInterface.addIndex('audit_logs', ['created_at'], {
    name: 'ix_audit_logs_created',
  });
}

async function down({ context: queryInterface }) {
  await queryInterface.removeIndex('audit_logs', 'ix_audit_logs_created');
  await queryInterface.removeIndex('audit_logs', 'ix_audit_logs_tenant_action_created');
  await queryInterface.removeIndex('audit_logs', 'ix_audit_logs_tenant_created');
}

module.exports = { up, down };
