import {
  CreateManyDto,
  CrudRequest,
  CrudRequestOptions,
  CrudService,
  GetManyDefaultResponse,
  JoinOption,
  JoinOptions,
  QueryOptions,
} from '@nestjsx/crud';
import {
  ParsedRequestParams,
  QueryFilter,
  ComparisonOperator,
  QueryJoin,
} from '@nestjsx/crud-request';
import {
  hasLength,
  isArrayFull,
  isObject,
  isUndefined,
  objKeys,
  isNil,
} from '@nestjsx/util';
import { oO } from '@zmotivat0r/o0';
import { Model } from 'sequelize-typescript';
import * as Sequelize from 'sequelize';
import * as _ from 'lodash';
import { classToPlain } from 'class-transformer';

interface Relation {
  target: typeof Model;
  as: string;
  allowedColumns: string[];
  primaryColumns: string[];
}

export class SequelizeCrudService<T extends Model> extends CrudService<T> {
  protected entityColumns: string[];
  protected entityPrimaryColumns: string[];
  protected entityColumnsHash: Record<string, any> = {};
  protected entityRelationsHash: Map<string, Relation> = new Map();
  protected sqlInjectionRegEx: RegExp[] = [
    /(%27)|(\')|(--)|(%23)|(#)/gi,
    /((%3D)|(=))[^\n]*((%27)|(\')|(--)|(%3B)|(;))/gi,
    /w*((%27)|(\'))((%6F)|o|(%4F))((%72)|r|(%52))/gi,
    /((%27)|(\'))union/gi,
  ];

  constructor(protected model: T & typeof Model) {
    super();
    this.onInitMapEntityColumns();
  }

  public async findOne(options: Sequelize.FindOptions): Promise<T | null> {
    const item = await this.model.findOne(options);
    return item as (T | null);
  }

  public async find(options: Sequelize.FindOptions): Promise<T[]> {
    const items = await this.model.findAll(options);
    return items as T[];
  }

  public async count(options: Sequelize.CountOptions): Promise<number> {
    return this.model.count(options);
  }

  /**
   * Get many
   * @param req
   */
  public async getMany(req: CrudRequest): Promise<GetManyDefaultResponse<T> | T[]> {
    const { parsed, options } = req;
    const query = this.createBuilder(parsed, options);
    const shouldPaginate = this.decidePagination(parsed, options);
    const res = await this.model.findAll({
      ...query,
      ...(shouldPaginate ? { subQuery: undefined } : {}),
    });
    if (shouldPaginate) {
      const count = await this.model.count({
        ...query,
        attributes: [],
        distinct: true,
        col: 'id',
      });
      // const { rows: data, count: total } = await this.model.findAndCountAll(query);
      return this.createPageInfo(
        res as T[],
        count,
        this.getTake(parsed, options.query),
        query.offset,
      );
    }

    return res as T[];
  }

  /**
   * Get one
   * @param req
   */
  public async getOne(req: CrudRequest): Promise<T> {
    return this.getOneOrFail(req);
  }

  /**
   * Create one
   * @param req
   * @param dto
   */
  public async createOne(req: CrudRequest, dto: T): Promise<T> {
    const { returnShallow } = req.options.routes.createOneBase;
    const entity = this.prepareEntityBeforeSave(dto, req.parsed);

    /* istanbul ignore if */
    if (!entity) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    const saved = await this.model.create(entity);

    if (returnShallow) {
      return saved as T;
    } else {
      const primaryParams = this.getPrimaryParams(req.options);

      /* istanbul ignore if */
      if (
        !primaryParams.length &&
        /* istanbul ignore next */ primaryParams.some((p) => isNil(saved[p]))
      ) {
        return saved as T;
      } else {
        req.parsed.search = primaryParams.reduce(
          (acc, p) => ({ ...acc, [p]: saved[p] }),
          {},
        );
        return this.getOneOrFail(req);
      }
    }
  }

  /**
   * Create many
   * @param req
   * @param dto
   */
  public async createMany(req: CrudRequest, dto: CreateManyDto<T>): Promise<T[]> {
    /* istanbul ignore if */
    if (!isObject(dto) || !isArrayFull(dto.bulk)) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    const bulk = dto.bulk
      .map((one) => this.prepareEntityBeforeSave(one, req.parsed))
      .filter((d) => !isUndefined(d));

    /* istanbul ignore if */
    if (!hasLength(bulk)) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    const created = await this.model.bulkCreate(bulk, { returning: true });
    return created as T[];
  }

  /**
   * Update one
   * @param req
   * @param dto
   */
  public async updateOne(req: CrudRequest, dto: T): Promise<T> {
    const { allowParamsOverride, returnShallow } = req.options.routes.updateOneBase;
    let tdto = this.transformDto(dto) as T;
    const paramsFilters = this.getParamFilters(req.parsed);
    const found = await this.getOneOrFail(req, returnShallow);
    let toSave = !allowParamsOverride
      ? { ...tdto, ...paramsFilters, ...req.parsed.authPersist }
      : { ...tdto, ...req.parsed.authPersist };

    // remove undefined fields
    found.set(toSave);
    const updated = await found.save();

    if (returnShallow) {
      return updated;
    } else {
      req.parsed.paramsFilter.forEach((filter) => {
        filter.value = updated[filter.field];
      });

      return this.getOneOrFail(req);
    }
  }

  /**
   * Replace one
   * @param req
   * @param dto
   */
  public async replaceOne(req: CrudRequest, dto: T): Promise<T> {
    const { allowParamsOverride, returnShallow } = req.options.routes.replaceOneBase;
    let tdto = this.transformDto(dto) as T;
    const paramsFilters = this.getParamFilters(req.parsed);
    const [, found] = await oO(this.getOneOrFail(req, returnShallow));
    let toSave = !allowParamsOverride
      ? { ...tdto, ...paramsFilters, ...req.parsed.authPersist }
      : { ...paramsFilters, ...tdto, ...req.parsed.authPersist };

    let replaced: Model<T>;
    if (found) {
      found.set(toSave);
      replaced = await found.save();
    } else {
      // don't set id if this record is not found, let the db set it
      delete toSave.id;
      const obj = this.model.build(toSave);
      replaced = await obj.save();
    }

    if (returnShallow) {
      return replaced as T;
    } else {
      const primaryParams = this.getPrimaryParams(req.options);

      /* istanbul ignore if */
      if (!primaryParams.length) {
        return replaced as T;
      }

      req.parsed.search = primaryParams.reduce(
        (acc, p) => ({ ...acc, [p]: replaced[p] }),
        {},
      );
      return this.getOneOrFail(req);
    }
  }

  /**
   * Delete one
   * @param req
   */
  public async deleteOne(req: CrudRequest): Promise<void | T> {
    const { returnDeleted } = req.options.routes.deleteOneBase;
    const found = await this.getOneOrFail(req, returnDeleted);
    const toReturn = returnDeleted ? found : undefined;
    await found.destroy();

    return toReturn;
  }

  public getParamFilters(parsed: CrudRequest['parsed']): Record<string, any> {
    let filters = {};

    /* istanbul ignore else */
    if (hasLength(parsed.paramsFilter)) {
      for (const filter of parsed.paramsFilter) {
        filters[filter.field] = filter.value;
      }
    }

    return filters;
  }

  /**
   * Create Sequelize Query builder
   * @param parsed
   * @param options
   * @param many
   */
  public createBuilder(
    parsed: ParsedRequestParams,
    options: CrudRequestOptions,
    many = true,
  ): Sequelize.FindOptions {
    // create query builder
    const query: Sequelize.FindOptions = {
      where: {},
      subQuery: false,
      attributes: [],
      include: [],
      order: [],
      limit: null,
      offset: null,
    };
    // get select fields
    query.attributes = _.uniq(this.getSelect(parsed, options.query));

    // set joins
    const joinOptions: JoinOptions = options.query.join || {};
    const allowedJoins = objKeys(joinOptions);

    let joinsArray: Sequelize.IncludeOptions[] = [];
    if (hasLength(allowedJoins)) {
      const eagerJoins: any = {};

      for (let i = 0; i < allowedJoins.length; i++) {
        /* istanbul ignore else */
        if (joinOptions[allowedJoins[i]].eager) {
          const cond = parsed.join.find((j) => j && j.field === allowedJoins[i]) || {
            field: allowedJoins[i],
          };
          const include = this.setJoin(cond, joinOptions);
          /* istanbul ignore else */
          if (include) {
            joinsArray.push(include);
          }
          eagerJoins[allowedJoins[i]] = true;
        }
      }

      if (isArrayFull(parsed.join)) {
        for (let i = 0; i < parsed.join.length; i++) {
          /* istanbul ignore else */
          if (!eagerJoins[parsed.join[i].field]) {
            const include = this.setJoin(parsed.join[i], joinOptions);
            if (include) {
              joinsArray.push(include);
            }
          }
        }
      }
    }

    // search
    // populate the alias map
    const aliases = {};
    if (options && options.query && options.query.join) {
      _.forEach(options.query.join, (join, association) => {
        if (join.alias) {
          aliases[join.alias] = association;
        }
      });
    }
    query.where = this.buildWhere(parsed.search, aliases, joinsArray);
    // console.log('WHERE', JSON.stringify(this.conditionalToPrintableObject(query.where), null, 2));

    if (isArrayFull(joinsArray)) {
      // convert nested joins
      query.include = this.convertNestedInclusions(joinsArray);
    }

    /* istanbul ignore else */
    if (many) {
      // set sort (order by)
      query.order = this.mapSort(
        parsed.sort,
        joinsArray.map((join) => join.association),
        joinOptions,
      );
      // set take
      const take = this.getTake(parsed, options.query);
      /* istanbul ignore else */
      if (isFinite(take)) {
        query.limit = take;
      }

      // set skip
      const skip = this.getSkip(parsed, take);
      /* istanbul ignore else */
      if (isFinite(skip)) {
        query.offset = skip;
      }
    }
    return query;
  }

  /**
   * Convert a flat include array into array with nested includes
   * @param include
   */
  protected convertNestedInclusions(
    include: Sequelize.IncludeOptions[],
  ): Sequelize.IncludeOptions[] {
    let nestedInclusions = include.filter(
      (item: Sequelize.IncludeOptions) => (item.association as string).indexOf('.') > -1,
    );
    nestedInclusions = _.sortBy(
      nestedInclusions,
      (item) => (item.association as string).split('.').length,
    );
    const convertedInclusions: Sequelize.IncludeOptions[] = include.filter(
      (item: Sequelize.IncludeOptions) =>
        (item.association as string).indexOf('.') === -1,
    );
    nestedInclusions.forEach((include) => {
      const names = (include.association as string).split('.');
      // traverse the include chain to find the right inclusion
      let parentInclude: Sequelize.IncludeOptions = {
        include: convertedInclusions,
        association: 'root',
      };
      let childInclude: Sequelize.IncludeOptions;
      // ensure the include objects exist
      for (let i = 0; i < names.length - 1; ++i) {
        childInclude = parentInclude.include.find(
          (item: Sequelize.IncludeOptions) => item.association === names[i],
        ) as Sequelize.IncludeOptions;
        /* istanbul ignore if */
        if (!childInclude) {
          // the parent entity of the nested include was not joined, ignore the nested include
          parentInclude = null;
          break;
        }
        /* istanbul ignore else */
        if (!childInclude.include) {
          childInclude.include = [];
        }
        parentInclude = childInclude;
      }
      /* istanbul ignore else */
      if (parentInclude) {
        parentInclude.include.push({
          ...include,
          association: _.last(names),
        });
      }
    });
    return convertedInclusions;
  }

  private isEmptyWhereConditional(where: any) {
    const yes =
      where === undefined ||
      (Array.isArray(where) && where.length === 0) ||
      (isObject(where) &&
        Object.keys(where).length === 0 &&
        Object.getOwnPropertySymbols(where).length === 0);
    return yes;
  }

  protected buildWhere(
    search: any,
    aliases: Record<string, string>,
    joinsArray: Sequelize.IncludeOptions[],
    field = '',
  ): Record<string, any> {
    let where: any;
    if (Array.isArray(search)) {
      where = search
        .map((item) => this.buildWhere(item, aliases, joinsArray))
        .filter((where) => !this.isEmptyWhereConditional(where));
    } else if (isObject(search)) {
      const keys = Object.keys(search);
      const objects = keys.map((key) => {
        if (this.isOperator(key)) {
          where = this.buildWhere(search[key], aliases, joinsArray, field);
          if (this.isEmptyWhereConditional(where)) {
            return undefined;
          }
          const { obj } = this.mapOperatorsToQuery({
            field,
            operator: key as ComparisonOperator,
            value: where,
          });
          return obj;
        } else if (key === '$and') {
          where = this.buildWhere(search[key], aliases, joinsArray);
          if (this.isEmptyWhereConditional(where)) {
            return undefined;
          }
          return {
            [Sequelize.Op.and]: where,
          };
        } else if (key === '$or') {
          where = this.buildWhere(search[key], aliases, joinsArray);
          if (this.isEmptyWhereConditional(where)) {
            return undefined;
          }
          return { [Sequelize.Op.or]: where };
        } else {
          if (key.indexOf('.') > -1) {
            // a key from a joined table
            let normalized = key;
            if (key.length > 2 && key[0] === '$' && key[key.length - 1] === '$') {
              normalized = key.slice(1, key.length - 1);
            }
            const tokens = normalized.split('.');
            const associations = tokens
              .slice(0, tokens.length - 1)
              .map((name) => aliases[name] || name);
            const attribute = tokens[tokens.length - 1];
            const joinObject = joinsArray.find(
              (join) => join.association === associations.join('.'),
            );
            where = this.buildWhere(search[key], aliases, joinsArray, normalized);
            if (this.isEmptyWhereConditional(where)) {
              return undefined;
            }
            if (joinObject) {
              joinObject.where = {
                [attribute]: where,
              };
              return undefined;
            } else {
              return {
                [`$${[...associations, attribute].join('.')}$`]: where,
              };
            }
          }

          where = this.buildWhere(search[key], aliases, joinsArray, key);
          if (this.isEmptyWhereConditional(where)) {
            return undefined;
          }
          return { [key]: where };
        }
      });
      where = Object.assign({}, ...objects);
    } else {
      // search is a value, just return it
      where = search;
    }
    return where;
  }

  mapSort(
    sorts: { field: string; order: string }[],
    joinsArray,
    joinOptions: JoinOptions,
  ) {
    const params: any[] = [];
    sorts.forEach((sort) => {
      this.checkSqlInjection(sort.field);
      this.validateHasColumn(sort.field, joinOptions);
      if (sort.field.indexOf('.') === -1) {
        params.push([sort.field, sort.order]);
      } else {
        const column: string = sort.field.split('.').pop();
        const associationName = sort.field.substr(0, sort.field.lastIndexOf('.'));
        const relation = this.getRelationMetadata(
          associationName,
          joinOptions[sort.field],
        );
        /* istanbul ignore else */
        if (relation && joinsArray.indexOf(associationName) !== -1) {
          let names = [];
          const modelList = associationName.split('.').map((k) => {
            names.push(k);
            const relation = this.getRelationMetadata(
              names.join('.'),
              joinOptions[sort.field],
            );
            return {
              model: relation.target,
              as: relation.as,
            };
          });
          params.push([...modelList, column, sort.order]);
        }
      }
    });
    return params;
  }

  private getSelect(query: ParsedRequestParams, options: QueryOptions): string[] {
    const allowed = this.getAllowedColumns(this.entityColumns, options);
    const columns =
      query.fields && query.fields.length
        ? query.fields.filter((field) => allowed.some((col) => field === col))
        : allowed;

    return [
      ...(options.persist && options.persist.length ? options.persist : []),
      ...columns,
      ...this.entityPrimaryColumns,
    ];
  }

  private getAllowedColumns(columns: string[], options: QueryOptions): string[] {
    return (!options.exclude || !options.exclude.length) &&
      (!options.allow || /* istanbul ignore next */ !options.allow.length)
      ? columns
      : columns.filter(
          (column) =>
            (options.exclude && options.exclude.length
              ? !options.exclude.some((col) => col === column)
              : /* istanbul ignore next */ true) &&
            (options.allow && options.allow.length
              ? options.allow.some((col) => col === column)
              : /* istanbul ignore next */ true),
        );
  }

  protected setJoin(
    cond: QueryJoin,
    joinOptions: JoinOptions,
  ): Sequelize.IncludeOptions | undefined {
    const options = joinOptions[cond.field];

    if (!options) {
      return;
    }

    const allowedRelation = this.getRelationMetadata(cond.field, options);

    if (!allowedRelation) {
      return;
    }

    const columns = isArrayFull(cond.select)
      ? cond.select.filter((column) =>
          allowedRelation.allowedColumns.some((allowed) => allowed === column),
        )
      : allowedRelation.allowedColumns;

    const attributes = [
      ...allowedRelation.primaryColumns,
      ...(isArrayFull(options.persist) ? options.persist : []),
      ...columns,
    ];

    return {
      association: cond.field,
      attributes: _.uniq(options.select === false ? [] : attributes),
      ...(!options || !options.required ? {} : { required: true }),
      ...(!options || !options.alias ? {} : { as: options.alias }),
    };
  }

  private validateHasColumn(column: string, joinOptions: JoinOptions) {
    if (column.indexOf('.') !== -1) {
      const nests = column.split('.');
      column = nests[nests.length - 1];
      const associationName = nests.slice(0, nests.length - 1).join('.');

      const relation = this.getRelationMetadata(associationName, joinOptions[column]);
      /* istanbul ignore if */
      if (!relation) {
        this.throwBadRequestException(`Invalid relation name '${relation}'`);
      }
      const noColumn = !Object.keys(relation.target.rawAttributes).find(
        (o) => o === column,
      );
      if (noColumn) {
        this.throwBadRequestException(
          `Invalid column name '${column}' for relation '${relation}'`,
        );
      }
    } else {
      /* istanbul ignore if */
      if (!this.hasColumn(column)) {
        this.throwBadRequestException(`Invalid column name '${column}'`);
      }
    }
  }

  protected async getOneOrFail(req: CrudRequest, shallow = false): Promise<T> {
    const { parsed, options } = req;
    const query = this.createBuilder(parsed, options);
    if (shallow) {
      query.include = undefined;
    }
    const found = await this.model.findOne(query);

    if (!found) {
      this.throwNotFoundException(this.model.name);
    }

    return found as T;
  }

  private hasColumn(column: string): boolean {
    return !!this.model.rawAttributes[column];
  }

  getRelationMetadata(path, options: JoinOption) {
    let allowedRelation: Relation;

    if (this.entityRelationsHash.has(path)) {
      allowedRelation = this.entityRelationsHash.get(path);
    } else {
      const names = path.split('.');
      let model: any = this.model;
      for (let i = 0; i < names.length; ++i) {
        /* istanbul ignore else */
        if (model) {
          allowedRelation = model.associations[names[i]];
          model = allowedRelation ? allowedRelation.target : undefined;
        }
      }

      if (allowedRelation) {
        allowedRelation.allowedColumns = this.getAllowedColumns(
          Object.keys(allowedRelation.target.rawAttributes),
          options || {},
        );
        allowedRelation.primaryColumns = _.map(
          allowedRelation.target.rawAttributes,
          (v) => v,
        )
          .filter((column) => column.primaryKey)
          .map((column) => column.field);

        this.entityRelationsHash.set(path, allowedRelation);
        if (options && options.alias) {
          this.entityRelationsHash.set(options.alias, allowedRelation);
        }
      }
    }

    return allowedRelation;
  }

  private onInitMapEntityColumns() {
    const columns = Object.keys(this.model.rawAttributes || {}).map(
      (key) => this.model.rawAttributes[key],
    );
    this.entityColumns = Object.keys(this.model.rawAttributes || {}).map((column) => {
      this.entityColumnsHash[column] = true;
      return column;
    });
    this.entityPrimaryColumns = columns
      .filter((column) => column.primaryKey)
      .map((column) => column.field);
  }

  protected prepareEntityBeforeSave(dto: T, parsed: CrudRequest['parsed']): T {
    let obj = JSON.parse(JSON.stringify(dto));
    /* istanbul ignore if */
    if (!isObject(obj)) {
      return undefined;
    }

    if (hasLength(parsed.paramsFilter)) {
      for (const filter of parsed.paramsFilter) {
        obj[filter.field] = filter.value;
      }
    }

    /* istanbul ignore if */
    if (!hasLength(objKeys(obj))) {
      return undefined;
    }
    return Object.assign(obj, parsed.authPersist);
  }

  get operators() {
    return {
      eq: true,
      ne: true,
      gt: true,
      lt: true,
      gte: true,
      lte: true,
      starts: true,
      ends: true,
      cont: true,
      excl: true,
      in: true,
      notin: true,
      isnull: true,
      notnull: true,
      between: true,
      eqL: true,
      neL: true,
      gtL: true,
      ltL: true,
      gteL: true,
      lteL: true,
      startsL: true,
      endsL: true,
      contL: true,
      exclL: true,
      inL: true,
      notinL: true,
      isnullL: true,
      notnullL: true,
      betweenL: true,
    };
  }

  isOperator(str: string): boolean {
    return this.operators[str.replace('$', '')];
  }

  /**
   * Get primary param name from CrudOptions
   * @param options
   */
  getPrimaryParams(options: CrudRequestOptions): string[] {
    const params = objKeys(options.params).filter(
      (n) => options.params[n] && options.params[n].primary,
    );

    return params.map((p) => options.params[p].field);
  }

  private escapeFieldname(field: string) {
    if (field.includes('.')) {
      return field;
    }
    // add the table to the attribute name
    return [this.model.name, field].join('.');
  }

  protected mapOperatorsToQuery(cond: QueryFilter) {
    let obj: {};
    let opKey = cond.operator.replace('$', '') as string;
    const field = this.escapeFieldname(cond.field);
    switch (opKey) {
      case 'eq':
        obj = {
          [Sequelize.Op.eq]: cond.value,
        };
        break;

      /* istanbul ignore next */
      case 'ne':
        obj = {
          [Sequelize.Op.ne]: cond.value,
        };
        break;

      case 'gt':
        obj = {
          [Sequelize.Op.gt]: cond.value,
        };
        break;

      case 'lt':
        obj = {
          [Sequelize.Op.lt]: cond.value,
        };
        break;

      case 'gte':
        obj = {
          [Sequelize.Op.gte]: cond.value,
        };
        break;

      case 'lte':
        obj = {
          [Sequelize.Op.lte]: cond.value,
        };
        break;

      case 'starts':
        obj = {
          [Sequelize.Op.like]: `${cond.value}%`,
        };
        break;

      case 'ends':
        obj = {
          [Sequelize.Op.like]: `%${cond.value}`,
        };
        break;

      case 'cont':
        obj = {
          [Sequelize.Op.like]: `%${cond.value}%`,
        };
        break;

      case 'excl':
        obj = {
          [Sequelize.Op.notLike]: `%${cond.value}%`,
        };
        break;

      case 'in':
        this.checkFilterIsArray(cond);
        obj = {
          [Sequelize.Op.in]: cond.value,
        };
        break;

      case 'notin':
        this.checkFilterIsArray(cond);
        obj = {
          [Sequelize.Op.notIn]: cond.value,
        };
        break;

      case 'isnull':
        obj = {
          [Sequelize.Op.is]: null,
        };
        break;

      case 'notnull':
        obj = {
          [Sequelize.Op.not]: null,
        };
        break;

      case 'between':
        this.checkFilterIsArray(cond);
        obj = {
          [Sequelize.Op.between]: cond.value,
        };
        break;
      // case insensitive
      case 'eqL':
        obj = {
          [Sequelize.Op.and]: [
            Sequelize.where(
              Sequelize.fn('lower', Sequelize.col(field)),
              Sequelize.fn('lower', cond.value),
            ),
          ],
        };
        break;

      case 'neL':
        obj = {
          [Sequelize.Op.and]: [
            Sequelize.where(
              Sequelize.fn('lower', Sequelize.col(field)),
              '!=',
              Sequelize.fn('lower', cond.value),
            ),
          ],
        };
        break;

      case 'startsL':
        obj = {
          [Sequelize.Op.and]: [
            Sequelize.where(
              Sequelize.fn('lower', Sequelize.col(field)),
              'like',
              Sequelize.fn('lower', `${cond.value}%`),
            ),
          ],
        };
        break;

      case 'endsL':
        obj = {
          [Sequelize.Op.and]: [
            Sequelize.where(
              Sequelize.fn('lower', Sequelize.col(field)),
              'like',
              Sequelize.fn('lower', `%${cond.value}`),
            ),
          ],
        };
        break;

      case 'contL':
        obj = {
          [Sequelize.Op.and]: [
            Sequelize.where(
              Sequelize.fn('lower', Sequelize.col(field)),
              'like',
              Sequelize.fn('lower', `%${cond.value}%`),
            ),
          ],
        };
        break;

      case 'exclL':
        obj = {
          [Sequelize.Op.and]: [
            Sequelize.where(
              Sequelize.fn('lower', Sequelize.col(field)),
              'not like',
              Sequelize.fn('lower', `%${cond.value}%`),
            ),
          ],
        };
        break;

      case 'inL':
        this.checkFilterIsArray(cond);
        obj = {
          [Sequelize.Op.and]: [
            Sequelize.where(Sequelize.fn('lower', Sequelize.col(field)), 'in', {
              [Sequelize.Op.in]: cond.value.map((value) => value.toLowerCase()),
            }),
          ],
        };
        break;

      case 'notinL':
        this.checkFilterIsArray(cond);
        obj = {
          [Sequelize.Op.and]: [
            Sequelize.where(Sequelize.fn('lower', Sequelize.col(field)), 'not in', {
              [Sequelize.Op.notIn]: cond.value.map((value) => value.toLowerCase()),
            }),
          ],
        };
        break;

      /* istanbul ignore next */
      default:
        obj = {
          [Sequelize.Op.eq]: cond.value,
        };
        break;
    }
    return { field, obj };
  }

  private checkFilterIsArray(cond: QueryFilter, withLength?: boolean) {
    /* istanbul ignore if */
    if (
      !Array.isArray(cond.value) ||
      !cond.value.length ||
      (!isNil(withLength) ? /* istanbul ignore next */ withLength : false)
    ) {
      this.throwBadRequestException(`Invalid column '${cond.field}' value`);
    }
  }

  private transformDto(dto: T) {
    return JSON.parse(JSON.stringify(dto instanceof Model ? classToPlain(dto) : dto));
  }

  private checkSqlInjection(field: string): string {
    /* istanbul ignore else */
    if (this.sqlInjectionRegEx.length) {
      for (let i = 0; i < this.sqlInjectionRegEx.length; i++) {
        /* istanbul ignore else */
        if (this.sqlInjectionRegEx[0].test(field)) {
          this.throwBadRequestException(`SQL injection detected: "${field}"`);
        }
      }
    }

    return field;
  }
}
