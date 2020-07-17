import { Parser, Insert_Replace, Update, Select } from 'node-sql-parser';
import { IQuery, TableNotFound, QueryError, CastError, SchemaField, DataType, IType } from './interfaces';
import { _IDb, AST2, CreateTable, CreateIndexColDef, _ISelection } from './interfaces-private';
import { NotSupported, trimNullish, watchUse } from './utils';
import { buildValue } from './predicate';
import { Types } from './datatypes';
import { JoinSelection } from './transforms/join';



export class Query implements IQuery {

    constructor(private db: _IDb) {
    }

    none(query: string): void {
        this._query(query);
    }

    many(query: string): any[] {
        return this._query(query);
    }

    private _query(query: string): any[] {
        const parser = new Parser();
        let parsed = parser.astify(query, {
            database: 'PostgresQL',
        }) as AST2 | AST2[];
        if (!Array.isArray(parsed)) {
            parsed = [parsed];
        }
        let last;
        for (const _p of parsed) {
            const p = watchUse(_p);
            switch (p.type) {
                case 'insert':
                    last = this.executeInsert(p);
                    break;
                case 'update':
                    last = this.executeUpdate(p);
                    break;
                case 'select':
                    last = this.executeSelect(p);
                    break;
                case 'create':
                    switch (p.keyword) {
                        case 'table':
                            last = this.executeCreateTable(p);
                            break;
                        case 'index':
                            last = this.executeCreateIndex(p);
                            break;
                        default:
                            throw new NotSupported('create ' + p.keyword);
                    }
                    break;
                default:
                    throw new NotSupported(p.type);
            }
            p.check?.();
        }
        return last;
    }
    executeCreateIndex(p: any): any {
        if (p.on_kw !== 'on') {
            throw new NotSupported(p.on_kw);
        }
        if (!p.with_before_where) { // what is this ? (always true)
            throw new NotSupported();
        }
        const indexName = p.index;
        const onTable = this.db.getTable(p.table.table);
        const columns = (p.index_columns as any[])
            .map<CreateIndexColDef>(x => {
                return {
                    value: buildValue(onTable.selection, x.column),
                    nullsLast: x.nulls === 'nulls last', // nulls are first by default
                    desc: x.order === 'desc',
                }
            });
        onTable
            .createIndex({
                columns,
                indexName,
            });
    }

    executeCreateTable(p: CreateTable): any {
        // get creation parameters
        const [{ table }] = p.table;
        const def = p.create_definitions;

        // perform creation
        this.db.declareTable({
            name: table,
            fields: def.filter(f => f.resource === 'column')
                .map<SchemaField>(f => {
                    if (f.column.type !== 'column_ref') {
                        throw new NotSupported(f.column.type);
                    }
                    let primary = false;
                    let unique = false;
                    switch (f.unique_or_primary) {
                        case 'primary key':
                            primary = true;
                            break;
                        case 'unique':
                            unique = true;
                            break;
                        case null:
                        case undefined:
                            break;
                        default:
                            throw new NotSupported(f.unique_or_primary);
                    }

                    const type: IType = (() => {
                        switch (f.definition.dataType) {
                            case 'TEXT':
                            case 'VARCHAR':
                                return Types.text(f.definition.length);
                            case 'INT':
                            case 'INTEGER':
                                return Types.int;
                            case 'DECIMAL':
                            case 'FLOAT':
                                return Types.float;
                            case 'TIMESTAMP':
                                return Types.timestamp;
                            case 'DATE':
                                return Types.date;
                            case 'JSON':
                                return Types.json;
                            case 'JSONB':
                                return Types.jsonb;
                            default:
                                throw new NotSupported('Type ' + JSON.stringify(f.definition.dataType));
                        }
                    })();

                    if (f.definition.suffix?.length) {
                        throw new NotSupported('column suffix');
                    }

                    return {
                        id: f.column.column,
                        type,
                        primary,
                        unique,
                    }
                })
        });
        return null;
    }

    executeSelect(p: Select): any[] {
        if (p.type !== 'select') {
            throw new NotSupported(p.type);
        }
        let t: _ISelection;
        const aliases = new Set<string>();
        for (const from of (p.from as any[])) {
            if (!('table' in from) || !from.table) {
                throw new NotSupported('no table name');
            }
            if (aliases.has(from.as ?? from.table)) {
                throw new Error(`Table name "${from.as ?? from.table}" specified more than once`)
            }
            const newT = this.db.getTable(from.table)
                .selection
                .setAlias(from.as);
            if (!t) {
                // first table to be selected
                t = newT;
                continue;
            }

            switch (from.join) {
                case 'RIGHT JOIN':
                    t = new JoinSelection(this.db, newT, t, from.on, from.join === 'INNER JOIN');
                    break;
                case 'INNER JOIN':
                    t = new JoinSelection(this.db, t, newT, from.on, true);
                    break;
                case 'LEFT JOIN':
                    t = new JoinSelection(this.db, t, newT, from.on, false);
                    break;
                default:
                    throw new NotSupported('Joint type not supported ' + from.join);
            }
        }
        t = t.filter(p.where)
            .select(p.columns);
        return [...t.enumerate()];
    }

    executeUpdate(p: Update): any[] {
        throw new Error('Method not implemented.');
    }

    executeInsert(p: Insert_Replace): void {
        if (p.type !== 'insert') {
            throw new NotSupported();
        }
        if (p.table?.length !== 1) {
            throw new NotSupported();
        }

        // get table to insert into
        let [into] = p.table;
        if (!('table' in into) || !into.table) {
            throw new NotSupported();
        }
        const intoTable = into.table;
        const t = this.db.getTable(intoTable);
        if (!t) {
            throw new TableNotFound(intoTable);
        }

        // get columns to insert into
        const columns: string[] = p.columns ?? t.selection.columns.map(x => x.id);

        // get values to insert
        const values = p.values;

        for (const val of values) {
            if (val.type !== 'expr_list') {
                throw new NotSupported('insert value type ' + val.type);
            }
            if (val.value.length !== columns.length) {
                throw new QueryError('Insert columns / values count mismatch');
            }
            const toInsert = {};
            for (let i = 0; i < val.value.length; i++) {
                const notConv = buildValue(null, val.value[i]);
                const col = t.selection.getColumn(columns[i]);
                const converted = notConv.convert(col.type);
                toInsert[columns[i]] = converted.get(null);
            }
            t.insert(toInsert);
        }
    }
}