// Grammar for GameMaker 6 / Studio 1.4 GML. gml.parser.mjs is generated from it (see gml.mjs).
// Strings are '...' or "..." with no escape sequences, semicolons are optional, and `=` is comparison
// inside expressions. Words like `if`, `do`, `and` or `mod` are ordinary identifiers except where a
// statement or operator is expected.
//
// Every node is {type, start, end, ...} with source offsets so transforms can splice text and keep the
// original formatting. Whitespace and comments are skipped before each token, never after, so a node
// ends at its last token. A trailing `;` belongs to var, do-until, break/continue/exit, return and simple
// statements; after anything else it is a separate Empty statement.
// Punctuation follows the longest match, as a tokenizer would: `<` never matches the start of `<=`.

{
  const node = (type, start, props) => ({ type, start, end: range().end, ...props });
  const binary = (head, tail) =>
    tail.reduce((left, [op, right]) => ({ type: 'Binary', op, left, right, start: left.start, end: right.end }), head);
  const tok = (type, value) => ({ type, value, start: range().start, end: range().end });
}

Program = _ start:Pos body:Statement* _ !. { return { type: 'Block', start, end: input.length, body }; }

// ---- Statements

Statement
  = start:S ";" { return node('Empty', start); }
  / Block
  / VarStatement
  / IfStatement
  / LoopStatement
  / DoStatement
  / ForStatement
  / SwitchStatement
  / JumpStatement
  / ReturnStatement
  / statement:SimpleStatement Semi { statement.end = range().end; return statement; }

Semi = (_ ";")?

Block = start:S "{" body:Statement* _ "}" { return { type: 'Block', start, end: range().end, body }; }

VarStatement = start:S kind:$("globalvar" / "var") !IdChar decls:VarDecls Semi { return node('Var', start, { kind, decls }); }

VarDecls = head:VarDecl tail:(_ "," @VarDecl)* { return [head, ...tail]; }

VarDecl
  = target:Primary value:(_ "=" !"=" @Expr)? {
      return value ? { type: 'Assign', start: target.start, end: value.end, target, op: '=', value } : target;
    }

IfStatement
  = start:S "if" !IdChar test:Expr (_ "then" !IdChar)? consequent:Statement alternate:(_ "else" !IdChar @Statement)? {
      return node('If', start, { test, consequent, alternate });
    }

LoopStatement
  = start:S kind:$("while" / "with" / "repeat") !IdChar test:Expr (_ "do" !IdChar)? body:Statement {
      return node({ while: 'While', with: 'With', repeat: 'Repeat' }[kind], start, { test, body });
    }

DoStatement = start:S "do" !IdChar body:Statement _ "until" !IdChar test:Expr Semi { return node('DoUntil', start, { body, test }); }

ForStatement
  = start:S "for" !IdChar _ "(" init:Statement test:Expr Semi update:(!(_ ")") @SimpleStatement)? Semi _ ")" body:Statement {
      return node('For', start, { init, test, update, body });
    }

SwitchStatement = start:S "switch" !IdChar disc:Expr _ "{" body:SwitchItem* _ "}" { return node('Switch', start, { disc, body }); }

SwitchItem
  = start:S "case" !IdChar test:Expr _ ":" !"=" { return node('Case', start, { test }); }
  / start:S "default" !IdChar _ ":" !"=" { return node('Case', start, { test: null }); }
  / Statement

JumpStatement = start:S kind:$("break" / "continue" / "exit") !IdChar Semi { return node('Jump', start, { kind }); }

ReturnStatement = start:S "return" !IdChar arg:(!(_ [;}]) @Expr)? Semi { return node('Return', start, { arg }); }

// An assignment, or a call or ++/-- used as a statement.
SimpleStatement
  = start:S target:Unary assign:(AssignOp Expr)? &{ return assign || target.type === 'Call' || target.type === 'Update'; } {
      return assign
        ? node('Assign', start, { target, op: assign[0], value: assign[1] })
        : node('ExprStmt', start, { expr: target });
    }

AssignOp = _ @$("<<=" / ">>=" / ":=" / "+=" / "-=" / "*=" / "/=" / "|=" / "&=" / "^=" / "=" !"=")

// ---- Expressions, lowest precedence first; binary operators are left-associative

Expr = head:And tail:(OrOp And)* { return binary(head, tail); }
OrOp = _ @$("||" / "or" !IdChar)

And = head:Xor tail:(AndOp Xor)* { return binary(head, tail); }
AndOp = _ @$("&&" / "and" !IdChar)

Xor = head:Compare tail:(XorOp Compare)* { return binary(head, tail); }
XorOp = _ @$("^^" / "xor" !IdChar)

Compare = head:Bitwise tail:(CompareOp Bitwise)* { return binary(head, tail); }
CompareOp = _ @$("==" / "!=" / "<>" / "<=" / ">=" / "=" !"=" / "<" ![<=>] / ">" ![>=])

Bitwise = head:Shift tail:(BitwiseOp Shift)* { return binary(head, tail); }
BitwiseOp = _ @$("|" ![|=] / "&" ![&=] / "^" ![\^=])

Shift = head:Additive tail:(ShiftOp Additive)* { return binary(head, tail); }
ShiftOp = _ @$("<<" !"=" / ">>" !"=")

Additive = head:Multiplicative tail:(AdditiveOp Multiplicative)* { return binary(head, tail); }
AdditiveOp = _ @$("+" ![+=] / "-" ![\-=])

Multiplicative = head:Unary tail:(MultiplicativeOp Unary)* { return binary(head, tail); }
MultiplicativeOp = _ @$("*" !"=" / "/" ![=/*] / "%" / "div" !IdChar / "mod" !IdChar)

Unary
  = start:S op:$("!" !"=" / "-" ![\-=] / "+" ![+=] / "~" / "not" !IdChar) arg:Unary { return node('Unary', start, { op, arg }); }
  / start:S op:$("++" / "--") arg:Unary { return node('Update', start, { op, prefix: true, arg }); }
  / Postfix

Postfix = head:(Call / Primary) tail:PostfixOp* { return tail.reduce((n, make) => make(n), head); }

// Only named functions can be called, so `if (a) (b).c=d` is an if with body `(b).c=d`.
Call = callee:Identifier _ "(" args:ExprList? _ ")" { return node('Call', callee.start, { callee, args: args ?? [] }); }

ExprList = head:Expr tail:(_ "," @Expr)* { return [head, ...tail]; }

// Each returns a function that wraps the node before it, with this operator's end offset.
PostfixOp
  = _ "[" index:ExprList _ "]" {
      const end = range().end;
      return (object) => ({ type: 'Index', start: object.start, end, object, index });
    }
  / _ "." ![0-9] prop:Identifier {
      const end = range().end;
      return (object) => ({ type: 'Member', start: object.start, end, object, prop });
    }
  / _ op:$("++" / "--") {
      const end = range().end;
      return (arg) => ({ type: 'Update', start: arg.start, end, op, prefix: false, arg });
    }

Primary
  = start:S value:String { return node('String', start, { value }); }
  / start:S value:Number { return node('Number', start, { value }); }
  / Identifier
  / start:S "(" expr:Expr _ ")" { return node('Paren', start, { expr }); }

Identifier = start:S name:IdentifierName { return node('Identifier', start, { name }); }

// ---- Tokens

// The flat token list, for scanning code without parsing it; ends with an eof token.
Tokens = tokens:(_ @Token)* _ !. { return [...tokens, { type: 'eof', value: '', start: input.length, end: input.length }]; }

Token
  = value:String { return tok('str', value); }
  / value:Number { return tok('num', value); }
  / value:IdentifierName { return tok('id', value); }
  / value:$("<<=" / ">>=" / "&&" / "||" / "^^" / "<<" / ">>" / "<=" / ">=" / "==" / "!=" / "<>" / ":=" / "+=" / "-="
      / "*=" / "/=" / "|=" / "&=" / "^=" / "++" / "--" / "/" !"*" / [-+*%<>=!&|^~?:;,.()[\]{}]) { return tok('op', value); }

String = '"' @$[^"]* '"' / "'" @$[^']* "'"

Number = $("$" [0-9a-fA-F]+ / [0-9]+ "."? [0-9]* / "." [0-9]+)

IdentifierName = $([A-Za-z_] IdChar*)

IdChar = [A-Za-z0-9_]

// The position of the next token.
S = _ @Pos

Pos = "" { return offset(); }

// Whitespace (as JavaScript's \s) and comments.
_ = ([\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff] / "//" [^\n]* / "/*" (!"*/" .)* "*/")*
