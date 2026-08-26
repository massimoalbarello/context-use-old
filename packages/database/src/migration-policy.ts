const FORBIDDEN_STATEMENT_STARTS = new Set([
  "CALL",
  "COPY",
  "DELETE",
  "DO",
  "INSERT",
  "MERGE",
  "SELECT",
  "UPDATE",
]);

type SqlStatement = {
  line: number;
  sql: string;
};

export type MigrationPolicyViolation = {
  line: number;
  statement: string;
};

export function migrationPolicyViolations(sql: string): MigrationPolicyViolation[] {
  return sqlStatements(sql).flatMap(({ line, sql: statement }) => {
    const words = statement.toUpperCase().match(/[A-Z]+/g) ?? [];
    const first = words[0];
    const dataChangingCte =
      first === "WITH" && words.some((word) => FORBIDDEN_STATEMENT_STARTS.has(word));
    if ((!first || !FORBIDDEN_STATEMENT_STARTS.has(first)) && !dataChangingCte) {
      return [];
    }
    return [{ line, statement: statement.trim().slice(0, 120) }];
  });
}

function sqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let current = "";
  let line = 1;
  let statementLine = 1;
  let index = 0;

  function appendWhitespace(character: string): void {
    current += character === "\n" ? "\n" : " ";
    if (character === "\n") {
      line += 1;
    }
  }

  function flush(): void {
    if (current.trim()) {
      statements.push({ line: statementLine, sql: current });
    }
    current = "";
    statementLine = line;
  }

  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];

    if (character === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        appendWhitespace(sql[index]!);
        index += 1;
      }
      continue;
    }

    if (character === "/" && next === "*") {
      appendWhitespace(character);
      appendWhitespace(next);
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        const blockCharacter = sql[index]!;
        const blockNext = sql[index + 1];
        if (blockCharacter === "/" && blockNext === "*") {
          depth += 1;
          appendWhitespace(blockCharacter);
          appendWhitespace(blockNext);
          index += 2;
          continue;
        }
        if (blockCharacter === "*" && blockNext === "/") {
          depth -= 1;
          appendWhitespace(blockCharacter);
          appendWhitespace(blockNext);
          index += 2;
          continue;
        }
        appendWhitespace(blockCharacter);
        index += 1;
      }
      continue;
    }

    if (character === "'") {
      appendWhitespace(character);
      index += 1;
      while (index < sql.length) {
        const stringCharacter = sql[index]!;
        appendWhitespace(stringCharacter);
        index += 1;
        if (stringCharacter !== "'") {
          continue;
        }
        if (sql[index] === "'") {
          appendWhitespace(sql[index]!);
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (character === '"') {
      appendWhitespace(character);
      index += 1;
      while (index < sql.length) {
        const identifierCharacter = sql[index]!;
        appendWhitespace(identifierCharacter);
        index += 1;
        if (identifierCharacter !== '"') {
          continue;
        }
        if (sql[index] === '"') {
          appendWhitespace(sql[index]!);
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (character === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
      if (tag) {
        for (const tagCharacter of tag) {
          appendWhitespace(tagCharacter);
        }
        index += tag.length;
        const closingIndex = sql.indexOf(tag, index);
        const bodyEnd = closingIndex === -1 ? sql.length : closingIndex + tag.length;
        while (index < bodyEnd) {
          appendWhitespace(sql[index]!);
          index += 1;
        }
        continue;
      }
    }

    if (character === ";") {
      flush();
      index += 1;
      continue;
    }

    if (!current.trim() && /\S/.test(character)) {
      statementLine = line;
    }
    current += character;
    if (character === "\n") {
      line += 1;
    }
    index += 1;
  }

  flush();
  return statements;
}
