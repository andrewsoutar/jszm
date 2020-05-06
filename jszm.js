/*
  JSZM - JavaScript implementation of Z-machine
  This program is in public domain.

  Documentation:

  The exported function called JSZM is the constructor, which takes a
  Uint8Array as input. You can also use JSZM.Version for the version
  number which is object with properties: major, minor, subminor,
  timestamp. Properties of JSZM instances are:

  .highlight(fixpitch) = A generator function you define, which will be
  called to update the highlighting mode, which is fixpitch (if the
  argument is true) or normal (if argument is false). (You don't have to
  set it if you aren't implementing variable pitch by default.)

  .isTandy = A boolean, normally false. Set it to true to tell the game
  that it is a Tandy computer; this affects some games.

  .print(text,scripting) = A generator function that you must define, and
  will be called to print text. You must implement wrapping and buffering
  and scripting yourself. The second argument is true if it should be
  copied to the transcript or false if it should not be.

  .read(maxlen) = A generator function which you must define yourself, and
  which should return a string containing the player's input. Called when
  a READ instruction is executed; the argument is the maximum number of
  characters that are allowed (if you return a longer string, it will be
  truncated).

  .restarted() = A generator function you can optionally define. When the
  game starts or if restarted (with the RESTART instruction), it will be
  called after memory is initialized but before executing any more.

  .restore() = A generator function you can define yourself, which is
  called when restoring a saved game. Return a Uint8Array with the same
  contents passed to save() if successful, or you can return false or null
  or undefined if it failed.

  .run() = A generator function. Call it to run the program from the
  beginning, and call the next() method of the returned object to begin
  and to continue. This generator may call your own generator functions
  which may yield; it doesn't otherwise yield by itself. You must set up
  the other methods before calling run so that it can properly set up the
  contents of the Z-machine mode byte. This generator only finishes when a
  QUIT instruction is executed.

  .save(buf) = A generator function you can define yourself, and is called
  when saving the game. The argument is a Uint8Array, and you should
  attempt to save its contents somewhere, and then return true if
  successful or false if it failed.

  .serial = The serial number of the story file, as six ASCII characters.

  .screen(window) = Normally null. You can set it to a generator function
  which will be called when the SCREEN opcode is executed if you want to
  implement split screen.

  .split(height) = Normally null. You can set it to a generator function
  which will be called when the SPLIT opcode is executed if you want to
  implement split screen.

  .statusType = False for score/moves and true for hours/minutes. Use this
  to determine the meaning of arguments to updateStatusLine.

  .updateStatusLine(text,v18,v17) = Normally null, but can be a generator
  function if you are implementing the status line. It is called when a
  READ or USL instruction is executed. See statusType for the meaning of
  v18 and v17. Return value is unused.

  .verify() = A normal function. Calling it will attempt to verify the
  story file, and returns true if successful or false on error. You can
  override it with your own verification function if you want to.

  .zorkid = The ZORKID of the story file. This is what is normally
  displayed as the release number.
*/

"use strict";

const JSZM_Version = {
  major: 2,
  minor: 0,
  subminor: 2,
  timestamp: 1480624305074
};

function splitBytes(bytes, ...counts) {
  return counts.reverse()
               .map(count => [bytes & ((1 << count) - 1), bytes >>>= count][0])
               .reverse();
}

function JSZM(arr) {
  let mem = this.memInit = new Uint8Array(arr);
  if (mem[0] != 3)
    throw new Error("Unsupported Z-code version.");
  this.byteSwapped = !!(mem[1] & 1);
  this.statusType = !!(mem[1] & 2);
  this.serial = String.fromCharCode(...mem.slice(18, 24));
  this.zorkid = (mem[2] << (this.byteSwapped ? 0 : 8)) | (mem[3] << (this.byteSwapped ? 8 : 0));
}

JSZM.prototype = {
  byteSwapped: false,
  constructor: JSZM,

  deserialize: function(ar) {
    var e, i, j, ds, cs, pc, vi, purbot;

    function getUint8() {
      return ar[e++];
    }
    function getInt16() {
      const val = vi.getInt16(e);
      e += 2;
      return val;
    }
    function getUint16() {
      const val = vi.getUint16(e);
      e += 2;
      return val;
    }
    function getUint24() {
      const val = vi.getUint32(e-1) & 0xFFFFFF;
      e += 3;
      return val;
    }
    function getUint32() {
      const val = vi.getUint32(e);
      e += 4;
      return val;
    }

    let g8 = getUint8,
        g16s = getInt16,
        g16 = getUint16,
        g24 = getUint24,
        g32 = getUint32;

    try {
      e = purbot = this.getu(14);
      vi = new DataView(ar.buffer);
      if (ar[2] != this.mem[2] || ar[3] != this.mem[3]) // ZORKID does not match
        return null;
      pc = getUint32();
      cs = new Array(getUint16());
      ds = Array.from({length: getUint16()}, getInt16);
      for(i=0; i < cs.length; i++) {
        cs[i] = {};
        cs[i].local = new Int16Array(getUint8());
        cs[i].pc = getUint24();
        cs[i].ds = Array.from({length: getUint16()}, getInt16);
        for(j=0; j < cs[i].local.length; j++)
          cs[i].local[j] = getInt16();
      }
      this.mem.set(new Uint8Array(ar.buffer, 0, purbot));
      return [ds,cs,pc];
    } catch(e) {
      return null;
    }
  },

  endText: 0,
  fwords: null,

  genPrint: function*(text) {
    var x = this.get(16);
    if(x != this.savedFlags) {
      this.savedFlags = x;
      yield* this.highlight(!!(x & 2));
    }
    yield* this.print(text, !!(x&1));
  },

  get: function(x) { return this.view.getInt16(x, this.byteSwapped); },

  getText: function(addr) {
    function* getEncodedChars() {
      for (;;) {
        const [done, ...chars] = splitBytes(this.getu(addr), 1, 5, 5, 5);
        addr += 2;
        yield* chars;
        if (done)
          break;
      }
    }

    var output = "";
    var permanentShift = 0;
    var temporaryShift = 0;
    var auxParsingState;

    const encodedCharGen = getEncodedChars.call(this);
    class StopIteration {}
    function getNextEncodedChar() {
      const {done, value} = encodedCharGen.next();
      if (done) {
        throw new StopIteration();
      } else {
        return value;
      }
    }
    for (;;) {
      try {
        const encodedChar = getNextEncodedChar();
        if (temporaryShift == 3) {
          auxParsingState = encodedChar << 5;
          temporaryShift = 4;
        } else if (temporaryShift == 4) {
          auxParsingState += encodedChar;
          if (auxParsingState == 13) {
            output += "\n";
          } else if (auxParsingState) {
            output += String.fromCharCode(auxParsingState);
          }
          temporaryShift = permanentShift;
        } else if (temporaryShift == 5) {
          output += this.getText(this.getu(this.fwords + (auxParsingState + encodedChar) * 2) * 2);
          temporaryShift = permanentShift;
        } else if (encodedChar == 0) {
          output += " ";
        } else if (encodedChar < 4) {
          temporaryShift = 5;
          auxParsingState = (encodedChar - 1) * 32;
        } else if (encodedChar < 6) {
          if (!temporaryShift)
            temporaryShift = encodedChar - 3;
          else if (temporaryShift == encodedChar - 3)
            permanentShift = temporaryShift;
          else
            permanentShift = temporaryShift = 0;
        } else if (encodedChar == 6 && temporaryShift == 2) {
          temporaryShift = 3;
        } else {
          output += "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ*\n0123456789.,!?_#'\"/\\-:()"[temporaryShift * 26 + encodedChar - 6];
          temporaryShift = permanentShift;
        }
      } catch (e) {
        if (e instanceof StopIteration) {
          break;
        } else {
          throw e;
        }
      }
    }

    this.endText = addr;
    return output;
  },
  getu: function(x) { return this.view.getUint16(x,this.byteSwapped); },
  handleInput: function(str,t1,t2) {
    var i,br,w;
    // Put text
    str=str.toLowerCase().slice(0,this.mem[t1]-1);
    for(i=0;i<str.length;i++) this.mem[t1+i+1]=str.charCodeAt(i);
    this.mem[t1+str.length+1]=0;
    // Lex text
    w=x=>(i=0,x.split("").filter(y => (i+=/[a-z]/.test(y)?1:/[0-9.,!?_#'"\/\\:\-()]/.test(y)?2:4)<7).join(""));
    br=JSON.parse("["+str.replace(this.regBreak,(m,o)=>",["+(m.length)+","+(this.vocabulary.get(w(m))||0)+","+(o+1)+"]").slice(1)+"]");
    i=this.mem[t2+1]=br.length;
    while(i--) {
      this.putu(t2+i*4+2,br[i][1]);
      this.mem[t2+i*4+4]=br[i][0];
      this.mem[t2+i*4+5]=br[i][2];
    }
  },
  highlight: ()=>[],
  isTandy: false,
  mem: null,
  memInit: null,
  parseVocab: function(s) {
    this.vocabulary=new Map();
    
    if (s === 0) {                                    // If the story file does not contain a dictionary..
      this.regBreak=new RegExp("[^ \\n\\t]+","g");    //   use the default word separators
      return;                                         //   and early exit.
    }

    var e;
    var n;
    n=this.mem[s++];
    e=this.selfInsertingBreaks=String.fromCharCode(...this.mem.slice(s,s+n));
    e=e.split("").map(x=>(x.toUpperCase()==x.toLowerCase()?"":"\\")+x).join("")+"]";
    this.regBreak=new RegExp("["+e+"|[^ \\n\\t"+e+"+","g");
    s+=n;
    e=this.mem[s++];
    n=this.get(s);
    s+=2;
    while(n--) {
      this.vocabulary.set(this.getText(s),s);
      s+=e;
    }
  },
  print: ()=>[],
  put: function(x,y) { return this.view.setInt16(x,y,this.byteSwapped); },
  putu: function(x,y) { return this.view.setUint16(x,y&65535,this.byteSwapped); },
  read: ()=>[],
  regBreak: null,
  restarted: ()=>[],
  restore: ()=>[],

  run: function*() {
    var mem,pc,cs,ds,y,z;
    var globals,objects,fwords,defprop;
    var addr,fetch,flagset,init,move,pcfetch,pcget,pcgetb,pcgetu,predicate,propfind,ret,store,xfetch,xstore;

    // Functions
    function addr(x) { return (x & 0xFFFF) << 1; }
    fetch=(x) => {
      if(x==0) return ds.pop();
      if(x<16) return cs[0].local[x-1];
      return this.get(globals+2*x);
    };
    flagset = (op0Nonshared, op1Nonshared) => { /* FIXME I know, these variable names suck */
      const op3Nonshared = 1 << (15 & ~op1Nonshared);
      const op2Nonshared = objects + op0Nonshared * 9 + (op1Nonshared & 16 ? 2 : 0);
      const opcNonshared = this.get(op2Nonshared);
      return [opcNonshared, op2Nonshared, op3Nonshared];
    };
    const initRng = () => {
      this.seed = (Math.random() * 0xFFFFFFFF) >>> 0;      
    };
    init=() => {
      mem=this.mem=new Uint8Array(this.memInit);
      this.view=new DataView(mem.buffer);
      mem[1]&=3;
      if(this.isTandy) mem[1]|=8;
      if(!this.updateStatusLine) mem[1]|=16;
      if(this.screen && this.split) mem[1]|=32;
      this.put(16,this.savedFlags);
      if(!this.vocabulary) this.parseVocab(this.getu(8));
      defprop=this.getu(10)-2;
      globals=this.getu(12)-32;
      this.fwords=fwords=this.getu(24);
      cs=[];
      ds=[];
      pc=this.getu(6);
      objects=defprop+55;
      initRng();
    };
    move=(x,y) => {
      var w,z;
      // Remove from old FIRST-NEXT chain
      if(z=mem[objects+x*9+4]) {
        if(mem[objects+z*9+6]==x) { // is x.loc.first=x?
          mem[objects+z*9+6]=mem[objects+x*9+5]; // x.loc.first=x.next
        } else {
          z=mem[objects+z*9+6]; // z=x.loc.first
          while(z!=x) {
            w=z;
            z=mem[objects+z*9+5]; // z=z.next
          }
          mem[objects+w*9+5]=mem[objects+x*9+5]; // w.next=x.next
        }
      }
      // Insert at beginning of new FIRST-NEXT chain
      if(mem[objects+x*9+4]=y) { // x.loc=y
        mem[objects+x*9+5]=mem[objects+y*9+6]; // x.next=y.first
        mem[objects+y*9+6]=x; // y.first=x
      } else {
        mem[objects+x*9+5]=0; // x.next=0
      }
    };
    pcfetch=(x) => fetch(mem[pc++]);
    pcget=() => {
      pc+=2;
      return this.get(pc-2);
    };
    pcgetb=() => mem[pc++];
    pcgetu=() => {
      pc+=2;
      return this.getu(pc-2);
    };
    predicate=(p) => {
      var x=pcgetb();
      if(x&128) p=!p;
      if(x&64) x&=63; else x=((x&63)<<8)|pcgetb();
      if(p) return;
      if(x==0 || x==1) return ret(x);
      if(x&0x2000) x-=0x4000;
      pc+=x-2;
    };
    propfind = (op0Nonshared, op1Nonshared) => {
      var z = this.getu(objects + op0Nonshared * 9 + 7);
      z += mem[z] * 2 + 1;
      while (mem[z]) {
        if ((mem[z] & 31) == op1Nonshared) {
          return [true, z + 1];
        } else {
          z += (mem[z] >> 5) + 2;
        }
      }
      return [false, 0];
    };
    ret=(x) => {
      ds=cs[0].ds;
      pc=cs[0].pc;
      cs.shift();
      store(x);
    };
    store=(y) => {
      var x=pcgetb();
      if(x==0) ds.push(y);
      else if(x<16) cs[0].local[x-1]=y;
      else this.put(globals+2*x,y);
    };
    xfetch=(x) => {
      if(x==0) return ds[ds.length-1];
      if(x<16) return cs[0].local[x-1];
      return this.get(globals+2*x);
    };
    xstore=(x,y) => {
      if(x==0) ds[ds.length-1]=y;
      else if(x<16) cs[0].local[x-1]=y;
      else this.put(globals+2*x,y);
    };

    // Initializations
    init();
    yield* this.restarted();
    yield* this.highlight(!!(this.savedFlags&2));

    // Main loop
    main: for(;;) {
      function getParameterByType(type) {
        return [pcget, pcgetb, pcfetch, () => undefined][type]();
      }

      class ZMachineQuit {};

      /* Operation parameter ranges, for below:
       * [000..031] :: 2 parameters, or variable parameters
       * [128..143] :: 0 or 1 parameter (assume 1?)
       * [176..191] :: no parsed parameters
       * [224..255] :: variable parameters
       */

      const z0opInstructions = {
        0x0: // RTRUE
        () => { /* void */
          ret(1);
        },
        0x1: // RFALSE
        () => { /* void */
          ret(0);
        },
        0x2: // PRINTI
        function*() { /* void */
          yield* this.genPrint(this.getText(pc));
          pc=this.endText;
        }.bind(this),
        0x3: // PRINTR
        function*() { /* void */
          yield* this.genPrint(this.getText(pc) + "\n");
          ret(1);
        }.bind(this),
        0x4: // NOOP
        () => {}, /* void */
        0x5: // SAVE
        function*() { /* void */
          this.savedFlags = this.get(16);
          predicate(yield* this.save(this.serialize(ds,cs,pc)));
        }.bind(this),
        0x6: // RESTORE
        function*() { /* void */
          this.savedFlags = this.get(16);
          if (z = yield* this.restore())
            z = this.deserialize(z);
          this.put(16, this.savedFlags);
          if (z) {
            ds = z[0];
            cs = z[1];
            pc = z[2];
          }
          predicate(z);
        }.bind(this),
        0x7: // RESTART
        function*() { /* void */
          init();
          yield* this.restarted();
        }.bind(this),
        0x8: // RSTACK
        () => { /* void */
          ret(ds[ds.length-1]);
        },
        0x9: // FSTACK
        () => { /* void */
          ds.pop();
        },
        0xA: // QUIT
        () => {
          throw new ZMachineQuit();
        },
        0xB: // CRLF
        function*() { /* void */
          yield* this.genPrint("\n");
        }.bind(this),
        0xC: // USL (update status line)
        function*() { /* void */
          if (this.updateStatusLine)
            yield* this.updateStatusLine(this.getText(this.getu(objects+xfetch(16)*9+7)+1),xfetch(18),xfetch(17));
        }.bind(this),
        0xD: // VERIFY
        () => { /* void */
          predicate(this.verify());
        }
      };

      const z1opInstructions = {
        0x0: // ZERO?
        (a) => { /* unary */
          predicate(!a);
        },
        0x1: // NEXT?
        (op0Nonshared) => { /* unary */
          const result = mem[objects + op0Nonshared * 9 + 5];
          store(result);
          predicate(result);
        },
        0x2: // FIRST?
        (op0Nonshared) => { /* unary */
          const result = mem[objects + op0Nonshared * 9 + 6];
          store(result);
          predicate(result);
        },
        0x3: // LOC
        (op0Nonshared) => { /* unary */
          store(mem[objects + op0Nonshared * 9 + 4]);
        },
        0x4: // PTSIZE
        (op0Nonshared) => { /* unary */
          store((mem[(op0Nonshared - 1) & 65535] >> 5) + 1);
        },
        0x5: // INC
        (loc) => { /* unary */
          const tmp = xfetch(loc);
          xstore(loc, tmp + 1);
        },
        0x6: // DEC
        (loc) => { /* unary */
          const tmp = xfetch(loc);
          xstore(loc, tmp - 1);
        },
        0x7: // PRINTB
        function*(strAddr) { /* unary */
          yield* this.genPrint(this.getText(strAddr & 65535));
        }.bind(this),

        0x9: // REMOVE
        (op0Nonshared) => { /* unary */
          move(op0Nonshared, 0);
        },
        0xA: // PRINTD
        function*(strAddr) { /* unary */
          yield* this.genPrint(this.getText(this.getu(objects + strAddr * 9 + 7) + 1));
        }.bind(this),
        0xB: // RETURN
        (retval) => { /* unary */
          ret(retval);
        },
        0xC: // JUMP
        (offset) => { /* unary */
          pc += offset - 2;
        },
        0xD: // PRINT
        function*(strAddr) { /* unary */
          yield* this.genPrint(this.getText(addr(strAddr)));
        }.bind(this),
        0xE: // VALUE
        (loc) => { /* unary */
          store(xfetch(loc));
        },
        0xF: // BCOM (binary complement)
        (a) => { /* unary */
          store(~a);
        }
      };

      const z2opInstructions = {
        0x01: // EQUAL?
        (key, ...values) => { /* vararg */
          predicate(typeof key === "undefined" || values.includes(key));
        },
        0x02: // LESS?
        (a, b) => { /* vararg */
          predicate(a < b);
        },
        0x03: // GRTR?
        (a, b) => { /* vararg */
          predicate(a > b);
        },
        0x04: // DLESS?
        (a, b) => { /* vararg */
          const tmp = xfetch(a) - 1;
          xstore(a, tmp);
          predicate(tmp < b);
        },
        0x05: // IGRTR?
        (a, b) => { /* vararg */
          const tmp = xfetch(a) + 1;
          xstore(a, tmp);
          predicate(tmp > b);
        },
        0x06: // IN?
        (op0Nonshared, op1Nonshared) => { /* vararg */
          predicate(mem[objects + op0Nonshared * 9 + 4] == op1Nonshared);
        },
        0x07: // BTST
        (a, bits) => { /* vararg */
          predicate((a & bits) == bits);
        },
        0x08: // BOR
        (a, b) => { /* vararg */
          store(a | b);
        },
        0x09: // BAND
        (a, b) => { /* vararg */
          store(a & b);
        },
        0x0A: // FSET?
        (op0Nonshared, op1Nonshared) => { /* vararg */
          const [opcNonshared, op2Nonshared, op3Nonshared] = flagset(op0Nonshared, op1Nonshared);
          predicate(opcNonshared & op3Nonshared);
        },
        0x0B: // FSET
        (op0Nonshared, op1Nonshared) => { /* vararg */
          const [opcNonshared, op2Nonshared, op3Nonshared] = flagset(op0Nonshared, op1Nonshared);
          this.put(op2Nonshared, opcNonshared | op3Nonshared);
        },
        0x0C: // FCLEAR
        (op0Nonshared, op1Nonshared) => { /* vararg */
          const [opcNonshared, op2Nonshared, op3Nonshared] = flagset(op0Nonshared, op1Nonshared);
          this.put(op2Nonshared, opcNonshared & ~op3Nonshared);
        },
        0x0D: // SET
        (loc, value) => { /* vararg */
          xstore(loc, value);
        },
        0x0E: // MOVE
        (op0Nonshared, op1Nonshared) => { /* vararg */
          move(op0Nonshared, op1Nonshared);
        },
        0x0F: // GET
        (op0Nonshared, op1Nonshared) => { /* vararg */
          store(this.get((op0Nonshared + op1Nonshared * 2) & 65535));
        },
        0x10: // GETB
        (op0Nonshared, op1Nonshared) => { /* vararg */
          store(mem[(op0Nonshared + op1Nonshared) & 65535]);
        },
        0x11: // GETP
        (op0Nonshared, op1Nonshared) => { /* vararg */
          let found, op3Nonshared;
          [found, op3Nonshared] = propfind(op0Nonshared, op1Nonshared);
          if (found) {
            store(mem[op3Nonshared - 1] & 32 ? this.get(op3Nonshared) : mem[op3Nonshared]);
          } else {
            store(this.get(defprop + 2 * op1Nonshared));
          }
        },
        0x12: // GETPT
        (op0Nonshared, op1Nonshared) => { /* vararg */
          const [, op3Nonshared] = propfind(op0Nonshared, op1Nonshared);
          store(op3Nonshared);
        },
        0x13: // NEXTP
        (op0Nonshared, op1Nonshared) => { /* vararg */
          if (op1Nonshared) {
            // Return next property
            const [, op3Nonshared] = propfind(op0Nonshared, op1Nonshared);
            store(mem[op3Nonshared + (mem[op3Nonshared - 1] >> 5) + 1] & 31);
          } else {
            // Return first property
            const firstProp = this.getu(objects + op0Nonshared * 9 + 7); /* FIXME I'm trusting the comment here to name the variable - I have no clue what this actually does */
            store(mem[firstProp + mem[firstProp] * 2 + 1] & 31);
          }
        },
        0x14: // ADD
        (a, b) => { /* vararg */
          store(a + b);
        },
        0x15: // SUB
        (a, b) => { /* vararg */
          store(a - b);
        },
        0x16: // MUL
        (a, b) => { /* vararg */
          store(Math.imul(a, b));
        },
        0x17: // DIV
        (a, b) => { /* vararg */
          store(Math.trunc(a / b));
        },
        0x18: // MOD
        (a, b) => { /* vararg */
          store(a % b);
        }
      };

      const zVarInstructions = {
        0x0: // CALL
        (method, ...params) => { /* vararg */
          if(method) {
            const tmp = mem[method = addr(method)];
            cs.unshift({ds: ds, pc: pc, local: new Int16Array(tmp)});
            ds = [];
            pc = method + 1;
            for (let i = 0; i < mem[method]; i++)
              cs[0].local[i] = pcget();
            if (params.length > 0 && typeof params[0] !== "undefined" && mem[method] > 0)
              cs[0].local[0] = params[0];
            if (params.length > 1 && typeof params[1] !== "undefined" && mem[method] > 1)
              cs[0].local[1] = params[1];
            if (params.length > 2 && typeof params[2] !== "undefined" && mem[method] > 2)
              cs[0].local[2] = params[2];
          } else {
            store(0);
          }
        },
        0x1: // PUT
        (op0Nonshared, op1Nonshared, op2Nonshared) => { /* vararg */
          this.put((op0Nonshared + op1Nonshared * 2) & 65535, op2Nonshared);
        },
        0x2: // PUTB
        (op0Nonshared, op1Nonshared, op2Nonshared) => { /* vararg */
          mem[(op0Nonshared + op1Nonshared) & 65535] = op2Nonshared;
        },
        0x3: // PUTP
        (op0Nonshared, op1Nonshared, op2Nonshared) => { /* vararg */
          const [, op3Nonshared] = propfind(op0Nonshared, op1Nonshared);
          if (mem[op3Nonshared - 1] & 32) {
            this.put(op3Nonshared, op2Nonshared);
          } else {
            mem[op3Nonshared] = op2Nonshared;
          }
        },
        0x4: // READ
        function*(op0Nonshared, op1Nonshared) { /* vararg */
          yield*this.genPrint("");
          if (this.updateStatusLine)
            yield* this.updateStatusLine(this.getText(this.getu(objects+xfetch(16)*9+7)+1),xfetch(18),xfetch(17));
          this.handleInput(yield* this.read(mem[op0Nonshared & 65535]),
                           op0Nonshared & 65535,
                           op1Nonshared & 65535);
        }.bind(this),
        0x5: // PRINTC
        function*(op0Nonshared) { /* vararg */
          yield* this.genPrint(op0Nonshared == 13 ? "\n" :
                               op0Nonshared ? String.fromCharCode(op0Nonshared) : "");
        }.bind(this),
        0x6: // PRINTN
        function*(op0Nonshared) { /* vararg */
          yield* this.genPrint(String(op0Nonshared));
        }.bind(this),
        0x7: // RANDOM
        (range) => { /* vararg */
          if (range <= 0) {             // If range is non-positive, reseed the PRNG.
            if (range === 0) {
              initRng();                // If 0, seed using Math.random().
            } else {
              this.seed = (range >>> 0); // If negative, seed with the specified value.
            }
            store(0);                   // Reseeding always returns 0.
          } else {
            this.seed = (1664525 * this.seed + 1013904223) >>> 0;     // Linear congruential generator
            store(Math.floor((this.seed / 0xFFFFFFFF) * range) + 1);  // Return integer in range [1..op0] (inclusive).
          }
        },
        0x8: // PUSH
        (a) => { /* vararg */
          ds.push(a);
        },
        0x9: // POP
        (loc) => { /* vararg */
          xstore(loc, ds.pop());
        },
        0xA: // SPLIT
        function*(op0Nonshared) { /* vararg */
          if(this.split)
            yield* this.split(op0Nonshared);
        }.bind(this),
        0xB: // SCREEN
        function*(op0Nonshared) { /* vararg */
          if(this.screen)
            yield* this.screen(op0Nonshared);
        }.bind(this)
      };

      function decodeInstruction() {
        const [notBinaryOp, rest1] = splitBytes(pcgetb(), 1, 7);
        if (notBinaryOp) {
          const [varInst, rest2] = splitBytes(rest1, 1, 6);
          if (varInst) {
            const [not2op, opcode] = splitBytes(rest2, 1, 5);
            return {
              fun: (not2op ? zVarInstructions : z2opInstructions)[opcode],
              parameters: splitBytes(pcgetb(), 2, 2, 2, 2).map(getParameterByType)
            };
          } else {
            const [op0Type, opcode] = splitBytes(rest2, 2, 4);
            const op0 = getParameterByType(op0Type);
            return {
              fun: (typeof op0 === "undefined" ? z0opInstructions : z1opInstructions)[opcode],
              parameters: [op0]
            };
          }
        } else {
          const [op0Type, op1Type, opcode] = splitBytes(rest1, 1, 1, 5);
          return {
            fun: z2opInstructions[opcode],
            parameters: [op0Type, op1Type].map(type => getParameterByType(type + 1))
          };
        }
      }

      const {fun, parameters} = decodeInstruction();
      if (typeof fun !== "undefined") {
        const GeneratorFunction = Object.getPrototypeOf(function*(){}).constructor;
        try {
          if (fun instanceof GeneratorFunction) {
            yield* fun(...parameters);
          } else {
            fun(...parameters);
          }
        } catch (e) {
          if (e instanceof ZMachineQuit) {
            return;
          } else {
            throw e;
          }
        }
      } else {
        throw new Error("JSZM: Invalid Z-machine opcode");
      }
    }

  },
  save: ()=>[],
  savedFlags: 0,
  selfInsertingBreaks: null,
  serial: null,
  serialize: function(ds,cs,pc) {
    var i,j,e,ar,vi;
    e=this.getu(14); // PURBOT
    i=e+cs.reduce((p,c)=>p+2*(c.ds.length+c.local.length)+6,0)+2*ds.length+8;
    ar=new Uint8Array(i);
    ar.set(new Uint8Array(this.mem.buffer,0,e));
    vi=new DataView(ar.buffer);
    vi.setUint32(e,pc);
    vi.setUint16(e+4,cs.length);
    vi.setUint16(e+6,ds.length);
    for(i=0;i<ds.length;i++) vi.setInt16(e+i*2+8,ds[i]);
    e+=ds.length*2+8;
    for(i=0;i<cs.length;i++) {
      vi.setUint32(e,cs[i].pc);
      vi.setUint8(e,cs[i].local.length);
      vi.setUint16(e+4,cs[i].ds.length);
      for(j=0;j<cs[i].ds.length;j++) vi.setInt16(e+j*2+6,cs[i].ds[j]);
      for(j=0;j<cs[i].local.length;j++) vi.setInt16(e+cs[i].ds.length*2+j*2+6,cs[i].local[j]);
      e+=(cs[i].ds.length+cs[i].local.length)*2+6;
    }
    return ar;
  },
  screen: null,
  split: null,
  statusType: null,
  updateStatusLine: null,
  verify: function() {
    var plenth=this.getu(26);
    var pchksm=this.getu(28);
    var i=64;
    while(i<plenth*2) pchksm=(pchksm-this.memInit[i++])&65535;
    return !pchksm;
  },
  view: null,
  vocabulary: null,
  zorkid: null,
};

JSZM.version=JSZM_Version;

try {
  if(module && module.exports) module.exports=JSZM;
} catch(e) {}
