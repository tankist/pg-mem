import { _ISchema, _Transaction, _ISequence, _IStatementExecutor, _IStatement, asSeq, asIndex, _INamedIndex } from '../../interfaces-private';
import { DropIndexStatement } from 'pgsql-ast-parser';
import { ExecHelper } from '../exec-utils';
import { ignore } from '../../utils';

export class DropIndex extends ExecHelper implements _IStatementExecutor {
    private idx: _INamedIndex<any> | null;


    constructor({ schema }: _IStatement, statement: DropIndexStatement) {
        super(statement);

        this.idx = asIndex(schema.getObject(statement.name, {
            nullIfNotFound: statement.ifExists,
        }));

        if (this.idx) {
            ignore(statement.concurrently);
        } else {
            ignore(statement);
        }
    }

    execute(t: _Transaction) {
        // commit pending data before making changes
        //  (because the index sequence creation does support further rollbacks)
        t = t.fullCommit();

        // alter the sequence
        this.idx?.onTable.dropIndex(t, this.idx.name);

        // new implicit transaction
        t = t.fork();

        return this.noData(t, 'DROP');
    }
}
