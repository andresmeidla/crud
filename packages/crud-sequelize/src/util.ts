import { isObject } from '@nestjsx/util';

export function conditionalToPrintableObject(where: any) {
  if (Array.isArray(where)) {
    return where.map((w) => this.conditionalToPrintableObject(w));
  } else if (isObject(where)) {
    const keys = [...Object.keys(where), ...Object.getOwnPropertySymbols(where)];
    const obj: any = {};
    keys.forEach((key) => {
      obj[key.toString()] = this.conditionalToPrintableObject(where[key]);
    });
    return obj;
  } else {
    return where;
  }
}
