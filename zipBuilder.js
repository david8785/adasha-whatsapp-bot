function buildZip(files) {
  function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
  function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
  function crc32(buf) {
    const t = new Uint32Array(256);
    for (let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[i]=c;}
    let c=0xffffffff;
    for (const b of buf) c=t[(c^b)&0xff]^(c>>>8);
    return (c^0xffffffff)>>>0;
  }
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from([0x50,0x4b,0x03,0x04]),
      u16(20),u16(0),u16(0),u16(0),u16(0),
      u32(crc),u32(data.length),u32(data.length),
      u16(name.length),u16(0),name
    ]);
    const ce = Buffer.concat([
      Buffer.from([0x50,0x4b,0x01,0x02]),
      u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),
      u32(crc),u32(data.length),u32(data.length),
      u16(name.length),u16(0),u16(0),u16(0),u16(0),
      u32(0),u32(offset),name
    ]);
    parts.push(local, data);
    central.push(ce);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([
    Buffer.from([0x50,0x4b,0x05,0x06]),
    u16(0),u16(0),u16(files.length),u16(files.length),
    u32(cd.length),u32(offset),u16(0)
  ]);
  return Buffer.concat([...parts, cd, eocd]);
}
module.exports = { buildZip };
