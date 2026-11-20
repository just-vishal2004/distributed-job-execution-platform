process.env.NODE_ENV = 'test';
process.env.PORT = '3002';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/test_db';
process.env.JWT_SECRET = 'test_jwt_secret_with_more_than_32_characters_for_testing';
process.env.EMAIL_DELIVERY_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.JWT_EXPIRES_IN = '7d';
process.env.CORS_ORIGIN = 'http://localhost:3000';
process.env.LOG_LEVEL = 'error';
