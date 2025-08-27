const express = require('express');
require('dotenv').config();
const cors = require('cors');
const { swaggerUi, swaggerSpec } = require('./swagger');
const empleadosRouter = require('./routes/empleados');
const authRouter = require('./routes/auth');
const proveedoresRouter = require('./routes/proveedores');
const refaccionesRouter = require('./routes/refacciones');
const autobusesRouter = require('./routes/autobuses');
const entradasRouter = require('./routes/entradaAlmacen');
const detallesEntradaRouter = require('./routes/detalleEntrada');
const salidasAlmacenRouter = require('./routes/salidasAlmacen');
const detalleSalidasRouter = require('./routes/detalleSalidas');
const dashboardRouter = require('./routes/dashboard');
const movimientosRouter = require('./routes/movimientos'); 
const historialMantenimientoRouter = require('./routes/historialMantenimiento');
const insumosRouter = require('./routes/insumos');
const entradasInsumoRouter = require('./routes/entradasInsumo');
const detalleSalidaInsumoRouter = require('./routes/detalleSalidaInsumo');
const lotesRouter = require('./routes/lotes');
const reportesRouter = require('./routes/reportes');
const detalleEntradaInsumoRoutes = require('./routes/detalleEntradaInsumo');


const app = express();

const whiteList = [
    'http://localhost:4200',        
    'https://sge-10.vercel.app'     
];
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || whiteList.includes(origin) || /\.vercel\.app$/.test(origin)) {
            callback(null, true);
        } else {
            callback(new Error('No permitido por CORS'));
        }
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    allowedHeaders: "Origin, X-Requested-With, Content-Type, Accept, Authorization"
};
app.use(cors(corsOptions));

app.use(express.json());

// Rutas API
app.use('/api', authRouter);
app.use('/api/auth', authRouter);
app.use('/api/empleados', empleadosRouter);
app.use('/api/proveedores', proveedoresRouter);
app.use('/api/refacciones', refaccionesRouter);
app.use('/api/autobuses', autobusesRouter);
app.use('/api/entradas', entradasRouter);
app.use('/api/detalle-entrada', detallesEntradaRouter);
app.use('/api/salidas', salidasAlmacenRouter);
app.use('/api/detalleSalida', detalleSalidasRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/movimientos', movimientosRouter);
app.use('/api/historial', historialMantenimientoRouter);
app.use('/api/insumos', insumosRouter);
app.use('/api/entradas-insumo', entradasInsumoRouter);
app.use('/api/detalle-salida-insumo', detalleSalidaInsumoRouter);
app.use('/api/lotes', lotesRouter);
app.use('/api/reportes', reportesRouter);
app.use('/api/detalle-entrada-insumo', detalleEntradaInsumoRoutes);
// Swagger
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  console.log(`Documentación Swagger en http://localhost:${PORT}/api-docs`);
});
