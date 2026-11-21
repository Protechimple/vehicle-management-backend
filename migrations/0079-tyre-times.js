const { DataTypes, QueryTypes } = require('sequelize');

// Every date in the Tyre module gets a time next to it, the same way fuel transactions did (0060): the date column
// stays (date rules, report filters and indexes are unchanged) and a TIME column is added beside it.
//
// Existing rows: the time is taken from when the row was saved, but only when it was saved on that same day (an entry
// made the same day). A back-dated entry's real time isn't known, so it stays empty and shows the date only.

const COLUMNS = [
  { table: 'tyre_purchases', date: 'purchase_date', time: 'purchase_time' },
  { table: 'tyre_events', date: 'event_date', time: 'event_time' },
  { table: 'tyre_transfers', date: 'transfer_date', time: 'transfer_time' },
  { table: 'tyres', date: 'fitted_at', time: 'fitted_time' },
  { table: 'tyres', date: 'scrapped_at', time: 'scrapped_time' },
];

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

async function up({ context: queryInterface }) {
  const { sequelize } = queryInterface;
  for (const { table, date, time } of COLUMNS) {
    await queryInterface.addColumn(table, time, { type: DataTypes.TIME, allowNull: true, after: date });
  }

  await sequelize.transaction(async (transaction) => {
    // Purchases, history rows and transfers: from their own save time.
    for (const { table, date, time } of COLUMNS.filter((c) => c.table !== 'tyres')) {
      const rows = await sequelize.query(`SELECT id, ${date} AS day, created_at AS createdAt FROM ${table}`, { type: QueryTypes.SELECT, transaction });
      for (const row of rows) {
        const saved = new Date(row.createdAt);
        if (localDate(saved) !== String(row.day).slice(0, 10)) continue;
        await sequelize.query(`UPDATE ${table} SET ${time} = :value WHERE id = :id`, { replacements: { value: localTime(saved), id: row.id }, transaction });
      }
    }
    // A tyre's fitting / scrapping time: from its latest matching history row.
    for (const [column, eventType, status] of [['fitted_time', 'fitted', 'fitted'], ['scrapped_time', 'scrapped', 'scrapped']]) {
      await sequelize.query(
        `UPDATE tyres t
            SET t.${column} = (SELECT e.event_time FROM tyre_events e
                                WHERE e.tyre_id = t.id AND e.event_type = '${eventType}'
                                ORDER BY e.event_date DESC, e.id DESC LIMIT 1)
          WHERE t.tyre_status = '${status}'`,
        { transaction }
      );
    }
  });
}

async function down({ context: queryInterface }) {
  for (const { table, time } of COLUMNS) await queryInterface.removeColumn(table, time);
}

module.exports = { up, down };
