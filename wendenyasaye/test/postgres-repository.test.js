const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { schema } = require('../scripts/export-postgres');
const { PostgresRepository } = require('../postgres-repository');

test('PostgreSQL repository reads and updates hymn and account data', {
  skip: process.env.POSTGRES_TEST !== '1' ? 'Set POSTGRES_TEST=1 and PostgreSQL connection environment variables to run.' : false
}, async () => {
  const namespace = `wende_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool();
  let repository;
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  try {
    repository = new PostgresRepository({ options: `-c search_path=${namespace},pg_catalog` });
    await repository.pool.query(schema);
    await repository.pool.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        (1, 'reader', 'Reader@example.com', 'hash'), (2, 'other', 'other@example.com', 'other-hash');
      INSERT INTO authors (id, name) VALUES (4, 'Test Author');
      INSERT INTO categories (id, name) VALUES (1, 'Worship'), (2, 'Praise'), (3, 'Empty');
      INSERT INTO hymns (id, number, title, lyrics, author_id, composer, slug) VALUES
        (10, 4, 'First Hymn', 'First line', 4, 'One; Two', 'first-hymn'),
        (11, NULL, 'Second Hymn', 'Second line', NULL, '', 'second-hymn');
      INSERT INTO hymn_categories VALUES (10, 1), (10, 2);
      INSERT INTO favorites VALUES (1, 10), (2, 11);
      INSERT INTO bookmarks (user_id, hymn_id, note, tags) VALUES
        (1, 10, 'private note', 'tag'), (2, 11, 'other note', '');
      SELECT setval(pg_get_serial_sequence('users', 'id'), 2);
      SELECT setval(pg_get_serial_sequence('authors', 'id'), 4);
      SELECT setval(pg_get_serial_sequence('categories', 'id'), 3);
      SELECT setval(pg_get_serial_sequence('hymns', 'id'), 11);
    `);
    const hymns = await repository.hymnsWithCategories();
    assert.deepEqual(hymns.map(hymn => hymn.id), [10, 11]);
    assert.deepEqual(hymns[0].categories, [{ id: 2, name: 'Praise' }, { id: 1, name: 'Worship' }]);
    assert.deepEqual(hymns[1].categories, []);
    assert.equal(hymns[0].author, 'Test Author');
    assert.equal(hymns[0].composer, 'One; Two');
    assert.deepEqual(await repository.categories(), [
      { id: 3, name: 'Empty', count: 0 }, { id: 2, name: 'Praise', count: 1 }, { id: 1, name: 'Worship', count: 1 }
    ]);
    assert.deepEqual(await repository.author(4), { id: 4, name: 'Test Author' });
    assert.equal(await repository.author(999), undefined);
    assert.equal((await repository.hymnBySlug('first-hymn')).lyrics, 'First line');
    assert.equal(await repository.hymnBySlug('missing'), undefined);
    assert.deepEqual(await repository.hymnById(10), { id: 10, slug: 'first-hymn' });
    assert.deepEqual(await repository.hymnCategories(10), [{ id: 2, name: 'Praise' }, { id: 1, name: 'Worship' }]);
    assert.deepEqual(await repository.favoriteIds(1), [10]);
    assert.deepEqual(await repository.favoriteIds(2), [11]);
    assert.equal((await repository.bookmark(1, 10)).note, 'private note');
    assert.equal(await repository.bookmark(2, 10), undefined);
    assert.deepEqual((await repository.bookmarks(1)).map(bookmark => bookmark.id), [10]);
    assert.equal((await repository.userByEmail('reader@EXAMPLE.com')).id, 1);
    assert.equal((await repository.userById(2)).password_hash, 'other-hash');
    assert.equal(await repository.userByEmail("anything' OR TRUE --"), undefined);
    const user = await repository.createUser('new@example.com', 'new@example.com', 'hash');
    assert.equal(user.role, 'user');
    await assert.rejects(repository.createUser('different', 'NEW@example.com', 'hash'), error => error.code === '23505');
    assert.equal(await repository.updateUser(user.id, 'changed@example.com', 'changed@example.com'), 1);
    assert.equal((await repository.userByEmail('CHANGED@example.com')).id, user.id);
    assert.equal(await repository.addFavorite(user.id, 10), 1);
    assert.equal(await repository.addFavorite(user.id, 10), 0);
    assert.equal(await repository.addBookmark(user.id, 10), 1);
    assert.equal(await repository.addBookmark(user.id, 10), 0);
    assert.equal(await repository.updateBookmark(user.id, 11, 'not allowed', ''), 0);
    assert.equal((await repository.bookmark(2, 11)).note, 'other note');
    assert.equal(await repository.updateBookmark(user.id, 10, 'private', 'my-tag'), 1);
    assert.equal((await repository.bookmark(user.id, 10)).note, 'private');
    assert.equal(await repository.removeFavorite(user.id, 10), 1);
    assert.equal(await repository.removeFavorite(user.id, 10), 0);
    assert.equal(await repository.addFavorite(user.id, 10), 1);
    await assert.rejects(repository.addBookmark(user.id, 99999), error => error.code === '23503');
    assert.equal(await repository.removeBookmark(user.id, 10), 1);
    assert.equal(await repository.removeBookmark(user.id, 10), 0);
    assert.equal(await repository.addBookmark(user.id, 10), 1);
    assert.equal(await repository.deleteRegularUser(user.id), 1);
    assert.equal(await repository.bookmark(user.id, 10), undefined);
    assert.deepEqual(await repository.favoriteIds(user.id), []);
    assert.equal(await repository.removeBookmark(2, 10), 0);
    const adminUser = await repository.createUser('admin', 'admin@example.com', 'hash', 'admin');
    assert.equal(await repository.deleteRegularUser(adminUser.id), 0);
    assert.ok(await repository.userById(adminUser.id));
    assert.ok((await repository.users()).every(entry => !('password_hash' in entry)));

    const category = await repository.createCategory('Thanksgiving');
    assert.deepEqual(await repository.category(category.id), category);
    await assert.rejects(repository.createCategory('THANKSGIVING'), error => error.code === '23505');
    assert.equal(await repository.updateCategory(category.id, 'Service'), 1);
    assert.equal((await repository.category(category.id)).name, 'Service');
    assert.equal(await repository.updateCategory(99999, 'Missing'), 0);

    const input = {
      title: 'New Hymn', number: null, lyrics: 'A verse', author: 'TEST AUTHOR',
      composer: 'Composer', pageNumber: 8
    };
    const ids = await Promise.all([
      repository.saveHymn(null, input, [category.id]),
      repository.saveHymn(null, input, [2])
    ]);
    const created = await Promise.all(ids.map(id => repository.hymnForEdit(id)));
    assert.deepEqual(created.map(hymn => hymn.slug).sort(), ['new-hymn', 'new-hymn-2']);
    assert.ok(created.every(hymn => hymn.author_id === 4));
    assert.equal((await repository.authors()).filter(author => author.name === 'Test Author').length, 1);
    assert.deepEqual(await repository.hymnCategories(ids[0]), [{ id: category.id, name: 'Service' }]);
    assert.equal(await repository.saveHymn(ids[0], { ...input, title: 'Edited title', author: 'New Author' }, [1, 2]), ids[0]);
    const edited = await repository.hymnForEdit(ids[0]);
    assert.equal(edited.title, 'Edited title');
    assert.equal(edited.slug, created[0].slug);
    assert.equal(edited.author, 'New Author');
    assert.deepEqual((await repository.hymnCategories(ids[0])).map(item => item.id), [2, 1]);
    assert.equal(await repository.saveHymn(99999, { ...input, author: 'Missing hymn author' }, []), undefined);
    assert.ok(!(await repository.authors()).some(author => author.name === 'Missing hymn author'));
    await assert.rejects(repository.saveHymn(ids[0], { ...input, title: 'Must rollback', author: 'Rollback Author' }, [99999]), error => error.code === '23503');
    assert.equal((await repository.hymnForEdit(ids[0])).title, 'Edited title');
    assert.deepEqual((await repository.hymnCategories(ids[0])).map(item => item.id), [2, 1]);
    assert.ok(!(await repository.authors()).some(author => author.name === 'Rollback Author'));
    await assert.rejects(repository.saveHymn(null, { ...input, number: 4, author: 'Duplicate Author' }, []), error => error.code === '23505');
    assert.ok(!(await repository.authors()).some(author => author.name === 'Duplicate Author'));
    const numeric = await repository.saveHymn(null, { ...input, title: '123', author: '' }, []);
    assert.equal((await repository.hymnForEdit(numeric)).slug, 'hymn-123');
    assert.equal((await repository.hymnForEdit(numeric)).author_id, null);
    assert.equal(await repository.deleteCategory(category.id), 1);
    assert.equal(await repository.category(category.id), undefined);
    assert.equal(await repository.deleteCategory(category.id), 0);
    await repository.addBookmark(1, ids[0]);
    await repository.addFavorite(1, ids[0]);
    assert.equal(await repository.deleteHymn(ids[0]), 1);
    assert.equal(await repository.bookmark(1, ids[0]), undefined);
    assert.ok(!(await repository.favoriteIds(1)).includes(ids[0]));
    assert.equal(await repository.deleteHymn(ids[0]), 0);
  } finally {
    if (repository) await repository.close();
    await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
    await admin.end();
  }
});
