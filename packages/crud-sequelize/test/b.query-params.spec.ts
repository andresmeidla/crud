import { Controller, INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SequelizeModule } from '@nestjs/sequelize';
import { RequestQueryBuilder } from '@nestjsx/crud-request';
import 'jest-extended';
import * as request from 'supertest';

import { Company } from '../../../integration/crud-sequelize/companies/company.model';
import { config } from '../../../integration/crud-sequelize/sequelize.config';
import { Project } from '../../../integration/crud-sequelize/projects/project.model';
import { User } from '../../../integration/crud-sequelize/users/user.model';
import { UserProfile } from '../../../integration/crud-sequelize/users-profiles/userprofile.model';
import { HttpExceptionFilter } from '../../../integration/shared/https-exception.filter';
import { Crud } from '../../crud/src/decorators';
import { CompaniesService } from './__fixture__/companies.service';
import { ProjectsService } from './__fixture__/projects.service';
import { UsersService } from './__fixture__/users.service';
import { MigrationHelper } from './migration-helper';
import { Sequelize } from 'sequelize';

// tslint:disable:max-classes-per-file
describe('#crud-sequelize', () => {
  beforeEach(async () => {
    const helper = new MigrationHelper(
      new Sequelize({ ...config, logging: !!process.env.SQL_LOG ? console.log : false }),
    );
    try {
      await helper.down();
      await helper.up();
    } finally {
      await helper.close();
    }
  });

  describe('#query params', () => {
    let app: INestApplication;
    let server: any;
    let qb: RequestQueryBuilder;

    @Crud({
      model: { type: Company },
      query: {
        exclude: ['updatedAt'],
        allow: ['id', 'name', 'domain', 'description'],
        filter: [{ field: 'id', operator: 'ne', value: 1 }],
        join: {
          users: {
            allow: ['id'],
          },
        },
        maxLimit: 5,
      },
    })
    @Controller('companies')
    class CompaniesController {
      constructor(public service: CompaniesService) {}
    }

    @Crud({
      model: { type: Project },
      routes: {
        updateOneBase: {
          returnShallow: true,
        },
      },
      query: {
        join: {
          company: {
            eager: true,
            persist: ['id'],
            allow: ['id'],
            exclude: ['updatedAt', 'createdAt'],
          },
          users: {},
          userProjects: {},
        },
        sort: [{ field: 'id', order: 'ASC' }],
        limit: 100,
      },
    })
    @Controller('projects')
    class ProjectsController {
      constructor(public service: ProjectsService) {}
    }

    @Crud({
      model: { type: Project },
    })
    @Controller('projects2')
    class ProjectsController2 {
      constructor(public service: ProjectsService) {}
    }

    @Crud({
      model: { type: Project },
      query: {
        filter: [{ field: 'isActive', operator: 'eq', value: false }],
      },
    })
    @Controller('projects3')
    class ProjectsController3 {
      constructor(public service: ProjectsService) {}
    }

    @Crud({
      model: { type: Project },
      query: {
        filter: { isActive: true },
      },
    })
    @Controller('projects4')
    class ProjectsController4 {
      constructor(public service: ProjectsService) {}
    }

    @Crud({
      model: { type: User },
      query: {
        join: {
          company: {},
          'company.projects': {},
          userLicenses: {},
        },
      },
    })
    @Controller('users')
    class UsersController {
      constructor(public service: UsersService) {}
    }

    @Crud({
      model: { type: User },
      query: {
        join: {
          company: {},
          'company.projects': {
            alias: 'pr',
          },
        },
      },
    })
    @Controller('users2')
    class UsersController2 {
      constructor(public service: UsersService) {}
    }

    @Crud({
      model: { type: User },
      query: {
        join: {
          profile: { required: true },
        },
      },
    })
    @Controller('users3')
    class UsersController3 {
      constructor(public service: UsersService) {}
    }

    beforeAll(async () => {
      const fixture = await Test.createTestingModule({
        imports: [
          SequelizeModule.forRoot({ ...config, logging: false }),
          SequelizeModule.forFeature([Company, Project, User, UserProfile]),
        ],
        controllers: [
          CompaniesController,
          ProjectsController,
          ProjectsController2,
          ProjectsController3,
          ProjectsController4,
          UsersController,
          UsersController2,
          UsersController3,
        ],
        providers: [
          { provide: APP_FILTER, useClass: HttpExceptionFilter },
          CompaniesService,
          UsersService,
          ProjectsService,
        ],
      }).compile();

      app = fixture.createNestApplication();

      await app.init();
      server = app.getHttpServer();
    });

    beforeEach(() => {
      qb = RequestQueryBuilder.create();
    });

    afterAll(async () => {
      await app.close();
    });

    describe('#select', () => {
      it('should throw status 400', () => {
        const query = qb.setFilter({ field: 'invalid', operator: 'isnull' }).query();
        return request(server)
          .get('/companies')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(500);
          });
      });
    });

    describe('#query filter', () => {
      it('should return data with limit', async () => {
        const query = qb.setLimit(4).query();
        return request(server)
          .get('/companies')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(4);
            res.body.forEach((e: Company) => {
              expect(e.id).not.toBe(1);
            });
          });
      });
      it('should return with maxLimit', async () => {
        const query = qb.setLimit(7).query();
        return request(server)
          .get('/companies')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(5);
          });
      });
      it('should return with filter and or, 1', async () => {
        const query = qb
          .setFilter({ field: 'name', operator: 'notin', value: ['Name2', 'Name3'] })
          .setOr({ field: 'domain', operator: 'cont', value: 5 })
          .query();
        return request(server)
          .get('/companies')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(5);
          });
      });
      it('should return with filter and or, 2', async () => {
        const query = qb
          .setFilter({ field: 'name', operator: 'ends', value: 'foo' })
          .setOr({ field: 'name', operator: 'starts', value: 'P' })
          .setOr({ field: 'isActive', operator: 'eq', value: true })
          .query();
        return request(server)
          .get('/projects')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(10);
          });
      });
      it('should return with filter and or, 3', async () => {
        const query = qb
          .setOr({ field: 'companyId', operator: 'gt', value: 22 })
          .setFilter({ field: 'companyId', operator: 'gte', value: 6 })
          .setFilter({ field: 'companyId', operator: 'lt', value: 10 })
          .query();
        return request(server)
          .get('/projects')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(8);
          });
      });
      it('should return with filter and or, 4', async () => {
        const query = qb
          .setOr({ field: 'companyId', operator: 'in', value: [6, 10] })
          .setOr({ field: 'companyId', operator: 'lte', value: 10 })
          .setFilter({ field: 'isActive', operator: 'eq', value: false })
          .setFilter({ field: 'description', operator: 'notnull' })
          .query();
        return request(server)
          .get('/projects')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(10);
          });
      });
      it('should return with filter and or, 6', async () => {
        const query = qb.setOr({ field: 'companyId', operator: 'isnull' }).query();
        return request(server)
          .get('/projects')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(0);
          });
      });
      it('should return with filter and or, 6', async () => {
        const query = qb
          .setOr({ field: 'companyId', operator: 'between', value: [1, 5] })
          .query();
        return request(server)
          .get('/projects')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(10);
          });
      });
      it('should return with filter, 1', async () => {
        const query = qb.setOr({ field: 'companyId', operator: 'eq', value: 1 }).query();
        return request(server)
          .get('/projects')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.length).toBe(2);
          });
      });
    });

    describe('#query join', () => {
      it('should return joined entity, 1', async () => {
        const query = qb.setJoin({ field: 'company', select: ['name'] }).query();
        return request(server)
          .get('/projects/2')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.company).toBeDefined();
          });
      });
      it('should return joined entity, 2', async () => {
        const query = qb.setJoin({ field: 'users', select: ['name'] }).query();
        return request(server)
          .get('/companies/2')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.users).toBeDefined();
            expect(res.body.users.length).not.toBe(0);
          });
      });
      it('should return 200 for non-eager required join', () => {
        const query = qb.setJoin({ field: 'profile' }).query();
        return request(server)
          .get('/users3/20')
          .query(query)
          .expect((res) => {
            expect(res.body.profile).toBeDefined();
          })
          .expect(200);
      });
      it('should return 404 for non-eager required join', () => {
        const query = qb.setJoin({ field: 'profile' }).query();
        return request(server)
          .get('/users3/21')
          .query(query)
          .expect(404);
      });
    });

    describe('#query nested join', () => {
      it('should return status 400, 1', async () => {
        const query = qb
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .setFilter({
            field: 'company.projects.foo',
            operator: 'excl',
            value: 'invalid',
          })
          .query();
        return request(server)
          .get('/users/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(500);
          });
      });
      it('should return status 400, 2', async () => {
        const query = qb
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .setFilter({
            field: 'invalid.projects',
            operator: 'excl',
            value: 'invalid',
          })
          .query();
        return request(server)
          .get('/users/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(500);
          });
      });
      it('should return status 400, 3', async () => {
        const query = qb
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .setFilter({
            field: 'company.foo',
            operator: 'excl',
            value: 'invalid',
          })
          .query();
        return request(server)
          .get('/users/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(500);
          });
      });
      it('should return status 200', async () => {
        const query = qb
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projectsinvalid' })
          .query();
        return request(server)
          .get('/users/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
          });
      });
      it('should return joined entity, 1', async () => {
        const query = qb
          .setFilter({ field: 'company.name', operator: 'excl', value: 'invalid' })
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .query();
        return request(server)
          .get('/users/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.company).toBeDefined();
            expect(res.body.company.projects).toBeDefined();
          });
      });
      it('should return joined entity, 2', async () => {
        const query = qb
          .setFilter({ field: 'company.projects.id', operator: 'notnull' })
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .query();
        return request(server)
          .get('/users/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.company).toBeDefined();
            expect(res.body.company.projects).toBeDefined();
          });
      });
      it('should return joined entity with alias', async () => {
        const query = qb
          .setFilter({ field: 'pr.id', operator: 'notnull' })
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .query();
        return request(server)
          .get('/users2/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.company).toBeDefined();
            expect(res.body.company.projects).toBeDefined();
          });
      });
      it('should return joined entity with ManyToMany pivot table', async () => {
        const query = qb
          .setJoin({ field: 'users' })
          .setJoin({ field: 'userProjects' })
          .query();
        return request(server)
          .get('/projects/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.users).toBeDefined();
            expect(res.body.users.length).toBe(2);
            expect(res.body.users[0].id).toBe(1);
            expect(res.body.userProjects).toBeDefined();
            expect(res.body.userProjects.length).toBe(2);
            expect(res.body.userProjects[0].review).toBe('User project 1 1');
          });
      });
    });

    describe('#query composite key join', () => {
      it('should return joined relation', async () => {
        const query = qb.setJoin({ field: 'userLicenses' }).query();
        return request(server)
          .get('/users/1')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(200);
            expect(res.body.userLicenses).toBeDefined();
          });
      });
    });

    describe('#sort', () => {
      it('should sort by field', async () => {
        const query = qb.sortBy({ field: 'id', order: 'DESC' }).query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body[1].id).toBeLessThan(res.body[0].id);
      });

      it('should sort by nested field, 1', async () => {
        const query = qb
          .setFilter({ field: 'company.id', operator: 'notnull' })
          .setJoin({ field: 'company' })
          .sortBy({ field: 'company.id', order: 'DESC' })
          .query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body[res.body.length - 1].company.id).toBeLessThan(
          res.body[0].company.id,
        );
      });

      // @TODO check the validity of this test, because
      // the field "projects.id" can not be be resolved with these joins
      /*it('should sort by nested field, 2', async () => {
        const query = qb
          .setFilter({ field: 'id', operator: 'eq', value: 1 })
          .setFilter({ field: 'company.id', operator: 'notnull' })
          .setFilter({ field: 'projects.id', operator: 'notnull' })
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .sortBy({ field: 'projects.id', order: 'DESC' })
          .query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body[0].company.projects[1].id).toBeLessThan(
          res.body[0].company.projects[0].id,
        );
      });*/
      it('should sort by nested field, 2', async () => {
        const query = qb
          .setFilter({ field: 'id', operator: 'eq', value: 1 })
          .setFilter({ field: 'company.id', operator: 'notnull' })
          .setFilter({ field: 'company.projects.id', operator: 'notnull' })
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .sortBy({ field: 'company.projects.id', order: 'DESC' })
          .query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body[0].company.projects[1].id).toBeLessThan(
          res.body[0].company.projects[0].id,
        );
      });

      // @TODO check the validity of this test, because
      // the field "projects.id" can not be be resolved with these joins
      /*it('should sort by nested field, 3', async () => {
        const query = qb
          .setFilter({ field: 'id', operator: 'eq', value: 1 })
          .setFilter({ field: 'company.id', operator: 'notnull' })
          .setFilter({ field: 'projects.id', operator: 'notnull' })
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .sortBy({ field: 'company.projects.id', order: 'DESC' })
          .query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body[0].company.projects[1].id).toBeLessThan(
          res.body[0].company.projects[0].id,
        );
      });
    });*/
      it('should sort by nested field, 3', async () => {
        const query = qb
          .setFilter({ field: 'id', operator: 'eq', value: 1 })
          .setFilter({ field: 'company.id', operator: 'notnull' })
          .setFilter({ field: 'company.projects.id', operator: 'notnull' })
          .setJoin({ field: 'company' })
          .setJoin({ field: 'company.projects' })
          .sortBy({ field: 'company.projects.id', order: 'DESC' })
          .query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body[0].company.projects[1].id).toBeLessThan(
          res.body[0].company.projects[0].id,
        );
      });

      it('should throw 400 if SQL injection has been detected', () => {
        const query = qb
          .sortBy({
            field: ' ASC; SELECT CAST( version() AS INTEGER); --',
            order: 'DESC',
          })
          .query();

        return request(server)
          .get('/companies')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(400);
          });
      });

      it('should throw 400 if column is not found, 1', () => {
        const query = qb
          .sortBy({
            field: 'nonexistingfield',
            order: 'DESC',
          })
          .query();

        return request(server)
          .get('/companies')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(400);
          });
      });
      it('should throw 400 if column is not found, 2', () => {
        const query = qb
          .sortBy({
            field: 'nonexistingtrelation.nonexistingfield',
            order: 'DESC',
          })
          .query();

        return request(server)
          .get('/companies')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(400);
          });
      });
      it('should throw 400 if column is not found, 3', () => {
        const query = qb
          .sortBy({
            field: 'users.nonexistingfield',
            order: 'DESC',
          })
          .setJoin({ field: 'users' })
          .query();

        return request(server)
          .get('/companies')
          .query(query)
          .expect((res) => {
            expect(res.status).toBe(400);
          });
      });
    });

    describe('#search', () => {
      const projects2 = () => request(server).get('/projects2');
      const projects3 = () => request(server).get('/projects3');
      const projects4 = () => request(server).get('/projects4');

      it('should return with search, 1', async () => {
        const query = qb.search({ id: 1 }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 2', async () => {
        const query = qb.search({ id: 1, name: 'Project1' }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 3', async () => {
        const query = qb.search({ id: 1, name: { $eq: 'Project1' } }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 4', async () => {
        const query = qb.search({ name: { $eq: 'Project1' } }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 5', async () => {
        const query = qb.search({ id: { $notnull: true, $eq: 1 } }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 6', async () => {
        const query = qb.search({ id: { $or: { $isnull: true, $eq: 1 } } }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 7', async () => {
        const query = qb.search({ id: { $or: { $eq: 1 } } }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 8', async () => {
        const query = qb
          .search({ id: { $notnull: true, $or: { $eq: 1, $in: [30, 31] } } })
          .query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 9', async () => {
        const query = qb.search({ id: { $notnull: true, $or: { $eq: 1 } } }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(1);
      });
      it('should return with search, 10', async () => {
        const query = qb.search({ id: null }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(0);
      });
      it('should return with search, 11', async () => {
        const query = qb
          .search({ $and: [{ id: { $notin: [5, 6, 7, 8, 9, 10] } }, { isActive: true }] })
          .query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(4);
      });
      it('should return with search, 12', async () => {
        const query = qb
          .search({ $and: [{ id: { $notin: [5, 6, 7, 8, 9, 10] } }] })
          .query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(14);
      });
      it('should return with search, 13', async () => {
        const query = qb.search({ $or: [{ id: 54 }] }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(0);
      });
      it('should return with search, 14', async () => {
        const query = qb
          .search({ $or: [{ id: 54 }, { id: 33 }, { id: { $in: [1, 2] } }] })
          .query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(2);
        expect(res.body[0].id).toBe(1);
        expect(res.body[1].id).toBe(2);
      });
      it('should return with search, 15', async () => {
        const query = qb.search({ $or: [{ id: 54 }], name: 'Project1' }).query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(0);
      });
      it('should return with search, 16', async () => {
        const query = qb
          .search({ $or: [{ isActive: false }, { id: 3 }], name: 'Project3' })
          .query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(3);
      });
      it('should return with search, 17', async () => {
        const query = qb
          .search({ $or: [{ isActive: false }, { id: { $eq: 3 } }], name: 'Project3' })
          .query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(3);
      });
      it('should return with search, 17', async () => {
        const query = qb
          .search({
            $or: [{ isActive: false }, { id: { $eq: 3 } }],
            name: { $eq: 'Project3' },
          })
          .query();
        const res = await projects2()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(3);
      });
      it('should return with default filter, 1', async () => {
        const query = qb.search({ name: 'Project11' }).query();
        const res = await projects3()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(11);
      });
      it('should return with default filter, 2', async () => {
        const query = qb.search({ name: 'Project1' }).query();
        const res = await projects3()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(0);
      });
      it('should return with default filter, 3', async () => {
        const query = qb.search({ name: 'Project2' }).query();
        const res = await projects4()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
        expect(res.body[0].id).toBe(2);
      });
      it('should return with default filter, 4', async () => {
        const query = qb.search({ name: 'Project11' }).query();
        const res = await projects4()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(0);
      });
      it('should return with eqL search operator', async () => {
        const query = qb.search({ name: { $eqL: 'project1' } }).query();
        const res = await projects4()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
      });
      it('should return with neL search operator', async () => {
        const query = qb.search({ name: { $neL: 'project1' } }).query();
        const res = await projects4()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(9);
      });
      it('should return with startsL search operator', async () => {
        const query = qb.search({ email: { $startsL: '2' } }).query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(3);
      });
      it('should return with endsL search operator', async () => {
        const query = qb.search({ domain: { $endsL: '2' } }).query();
        const res = await request(server)
          .get('/companies')
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(1);
      });
      it('should return with contL search operator', async () => {
        const query = qb.search({ email: { $contL: '1@' } }).query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(3);
      });
      it('should return with exclL search operator', async () => {
        const query = qb.search({ email: { $exclL: '1@' } }).query();
        const res = await request(server)
          .get('/users')
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(18);
      });
      it('should return with inL search operator', async () => {
        const query = qb.search({ name: { $inL: ['name2', 'name3'] } }).query();
        const res = await request(server)
          .get('/companies')
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(2);
      });
      it('should return with notinL search operator', async () => {
        const query = qb
          .search({ name: { $notinL: ['project7', 'project8', 'project9'] } })
          .query();
        const res = await projects4()
          .query(query)
          .expect(200);
        expect(res.body).toBeArrayOfSize(7);
      });
    });

    describe('#update', () => {
      it('should update company id of project', async () => {
        await request(server)
          .patch('/projects/18')
          .send({ companyId: 10 })
          .expect(200);

        const modified = await request(server)
          .get('/projects/18')
          .expect(200);

        expect(modified.body.companyId).toBe(10);
      });
    });
  });
});