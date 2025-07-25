const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'API Gestión de Almacén - Autobuses 8 de Marzo',
    version: '1.0.0',
    description: 'Documentación de la API para el sistema de gestión de almacén de la empresa Autobuses 8 de Marzo.',
    contact: {
      name: 'Sergio Carrillo',
      email: 'sergio@autobuses8demarzo.com'
    }
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Servidor local'
    }
  ],
};

const options = {
  swaggerDefinition,
  apis: [
    './routes/*.js'], 
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = {
  swaggerUi,
  swaggerSpec,
};