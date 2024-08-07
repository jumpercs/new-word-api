const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const { promisify } = require('util');
const readFileAsync = promisify(fs.readFile);
require('dotenv').config();
const promClient = require('prom-client');
const expressMiddleware = require('express-prometheus-middleware');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const bodyParser = require('body-parser');
const Tesseract = require('tesseract.js');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

let startTime;

// Obtenha a hora atual via NTP
startTime = new Date();
let corsOptions = {
  origin: '*',
  optionsSuccessStatus: 200
};

// configurar cors para aceitar requisições de qualquer origem
app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

//verifiy if the folder exists and create if not
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Configuração do multer para o upload de arquivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, process.env.UPLOAD_DIR || 'uploads/'); // Use UPLOAD_DIR do .env
  },
  filename: (req, file, cb) => {
    const extensaoArquivo = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}${extensaoArquivo}`);
  }
});
const upload = multer({ storage: storage });

// Função para validar a extensão do arquivo
const validarExtensaoArquivo = (arquivo) => {
  const extensoesPermitidas = ['.png', '.jpg', '.jpeg', '.jfif', '.pjpeg', '.pjp'];
  const extensaoArquivo = path.extname(arquivo.originalname).toLowerCase();
  return extensoesPermitidas.includes(extensaoArquivo);
};

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DATABASE,
  password: process.env.POSTGRES_PASSWORD,
  port: 5432,
});

const checkRegistrationWindow = (req, res, next) => {
  //ntp time because the server is a container and the time is not the same as the host

  let now;

  now = new Date();
  const diff = now - startTime;
  const hoursDiff = diff / (1000 * 60 * 60);

  if (hoursDiff > 12) {
    return res.status(403).json({ error: 'A janela de registro já expirou.' });
  }
  next();
};

const verifyWordAssignment = async (userID) => {
  try {
    const client = await pool.connect();
    try {

      const result = await client.query(
        `UPDATE words 
          SET delivered = FALSE, who_delivered = 'SYSTEM', date_delivered = NULL, assigned_at = NULL 
          WHERE delivered = TRUE AND assigned_at < (NOW() - INTERVAL '1 minutes')`
      );

      if (result.rows.length > 0) {
        const assignedWord = result.rows[0];
        let currentTime;

        currentTime = new Date();
        const assignedTime = new Date(assignedWord.assigned_at);
        const timeDiff = (currentTime - assignedTime) / (1000 * 60); // Diferença em minutos

        console.log(`Palavra atribuída: ${assignedWord.word}`);
        console.log(`Atribuída em: ${assignedTime}`);
        console.log(`Tempo decorrido desde a atribuição: ${timeDiff} minutos`);


        if (timeDiff > 1) {
          await client.query(
            'UPDATE words SET delivered = FALSE, who_delivered = \'SYSTEM\', date_delivered = NULL, assigned_at = NULL WHERE id = $1',
            [assignedWord.id]
          );
          return { status: 'expired', message: 'A palavra atribuída expirou.' };
        }

        return { status: 'assigned', message: 'Palavra atribuída encontrada.', word: assignedWord.word };
      } else {


        return { status: 'no_assignment', message: 'Nenhuma palavra atribuída.' };
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Erro ao verificar atribuição de palavra:', err);
    return { status: 'error', message: 'Erro ao verificar atribuição de palavra.' };
  }
};


app.post('/upload', checkRegistrationWindow, upload.single('imagem'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo de imagem enviado.' });
  }
  if (!validarExtensaoArquivo(req.file)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Extensão de arquivo inválida. São permitidos apenas arquivos PNG, JPG e JPEG.' });
  }

  const imagePath = req.file.path;

  try {
    // const verificationResult = await verifyWordAssignment(userID);

    // if (verificationResult.status === 'expired') {
    //   return res.status(400).json({ message: verificationResult.message });
    // } else if (verificationResult.status === 'no_assignment') {
    //   return res.status(400).json({ message: verificationResult.message });
    // } else if (verificationResult.status === 'error') {
    //   return res.status(500).json({ message: verificationResult.message });
    // }

    const word = req.body.texto;

    const { data: { text } } = await Tesseract.recognize(
      imagePath,
      'por',
      { logger: m => console.log(`Tesseract: ${m}`) }
    );

    const palavraExtraida = text.trim();

    if (word == palavraExtraida) {
      return res.json({ message: 'A palavra coincide.', word: word });
    } else {
      console.log(`Palavra extraída: ${palavraExtraida}`);
      console.log(`Palavra esperada: ${word}`);
      return res.status(400).json({ message: `${palavraExtraida} -> ${word}`, word: word });
    }
  } catch (error) {
    console.error('Erro ao processar OCR:', error);
    if (error.code === 'ENOENT') {
      return res.status(400).json({ error: 'Arquivo de imagem não encontrado.' });
    }
    res.status(500).json({ error: 'Erro ao processar OCR.' });
  } finally {
    fs.unlinkSync(imagePath);
  }
});

// Rota para servir arquivos estáticos (imagens)
app.use('/uploads', express.static(process.env.UPLOAD_DIR || 'uploads/')); // Use UPLOAD_DIR do .env

// Configuração do Prometheus
const collectDefaultMetrics = promClient.collectDefaultMetrics;
const Registry = promClient.Registry;
const register = new Registry();
collectDefaultMetrics({ register });

const prometheusMiddleware = expressMiddleware({
  metricsPath: '/metrics',
  collectDefaultMetrics: true,
  registry: register,
});

// Use o middleware do Prometheus
app.use(prometheusMiddleware);

const createTableWords = async () => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)', ['words']);
      if (!result.rows[0].exists) {
        await client.query('CREATE TABLE words (id SERIAL PRIMARY KEY, word TEXT NOT NULL, index INT NOT NULL, delivered BOOLEAN DEFAULT FALSE, date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, date_delivered TIMESTAMP, who_delivered TEXT NOT NULL, assigned_at TIMESTAMP)');
        console.log('Tabela words criada com sucesso!');
      } else {
        console.log('Tabela words já existe!');
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Erro ao criar a tabela words:', err);
  }
};

const populateDatabase = async () => {
  let startTime = new Date().getTime();
  try {
    const text = await readFileAsync('biblia.txt', 'utf8');
    const words = text.toUpperCase().split(/\s+/); // Convert to uppercase

    const client = await pool.connect();
    try {
      for (let i = 0; i < words.length; i++) {
        let word = words[i];
        // const connectShortWords = (word, words, index) => {
        //   if (word.length <= 2) {
        //     const nextIndex = index + 1;
        //     const nextWord = words[nextIndex];
        //     if (nextWord.length <= 2) {
        //       const nextNextIndex = nextIndex + 1;
        //       const nextNextWord = words[nextNextIndex];
        //       if (nextNextWord.length <= 2) {
        //         word = `${word} ${nextWord} ${nextNextWord}`;
        //         index = nextNextIndex;
        //       } else {
        //         word = `${word} ${nextWord}`;
        //         index = nextIndex;
        //       }
        //     } else {
        //       word = `${word} ${nextWord}`;
        //       index = nextIndex;
        //     }
        //   }
        //   return { word, index };
        // };




        await client.query('INSERT INTO words (word, index, who_delivered) VALUES ($1, $2, $3)', [word, i, 'SYSTEM']);

        let progress = Math.round((i + 1) / words.length * 100);

        console.log(`Progresso: ${progress}% - Inserindo palavra ${i + 1} de ${words.length} no banco de dados. Palavra: ${word}`);

        if (i % 1000 === 0) {
          console.log(`Inseridas ${i} palavras de ${words.length}`);
        }
      }
    } finally {
      client.release();
    }

    console.log('Banco de dados populado com sucesso!');
    let endTime = new Date().getTime();
    let timeDiff = endTime - startTime;
    console.log(`Tempo de execução: ${timeDiff} ms`);

  } catch (err) {
    let endTime = new Date().getTime();
    let timeDiff = endTime - startTime;
    console.error(`Erro ao popular o banco de dados: ${err}`);
    console.log(`Tempo de execução: ${timeDiff} ms`);
  }
};

const countRecords = async () => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT COUNT(*) FROM words');
      return result.rows[0].count;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Erro ao contar os registros:', err);
  }
};

const getNextWord = async (userID) => {
  try {
    const client = await pool.connect();
    try {
      const userHasWordResult = await client.query(
        'SELECT 1 FROM words WHERE who_delivered = $1 AND delivered = TRUE',
        [userID]
      );
      if (userHasWordResult.rows.length > 0) {
        console.log(`Usuário ${userID} já foi atrelado a uma palavra.`);
        return { hasWord: true, nextWord: null };
      }

      const result = await client.query(
        'SELECT word, id FROM words WHERE delivered = FALSE ORDER BY id ASC LIMIT 1'
      );
      if (result.rows.length > 0) {
        let word = result.rows[0].word;
        let id = result.rows[0].id;

        await client.query(
          'UPDATE words SET delivered = TRUE, date_delivered = NOW(), who_delivered = $1 WHERE id = $2',
          [userID, id]
        );
        return { hasWord: false, nextWord: { word, id } };
      } else {
        return { hasWord: false, nextWord: null };
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Erro ao obter a próxima palavra:', err);
    return { hasWord: false, nextWord: null };
  }
};

app.get('/obter-palavra', checkRegistrationWindow, async (req, res) => {
  const userID = req.query.userID;
  if (!userID) {
    res.status(400).json({ mensagem: 'O ID do usuário é obrigatório.' });
    return;
  }

  const { hasWord, nextWord } = await getNextWord(userID);

  if (hasWord) {
    res.status(400).json({ mensagem: 'Usuário já foi atrelado a uma palavra.' });
    return;
  }
  if (nextWord) {
    res.json(nextWord);
  } else {
    res.status(404).json({ mensagem: 'Não há mais palavras disponíveis.' });
  }
});

app.get('/contar-registros', async (req, res) => {
  const totalRecords = await countRecords();
  res.json({ totalRecords });
});

// endpoint para resetar o banco de dados
app.post('/resetar-banco', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await resetDatabaseToInitialState();
      res.json({ mensagem: 'Banco de dados resetado com sucesso.' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Erro ao resetar o banco de dados:', err);
    res.status(500).json({ mensagem: 'Erro ao resetar o banco de dados.' });
  }
});

const resetDatabaseToInitialState = async () => {
  try {
    const client = await pool.connect();
    try {
      // remover as referencias de quem entregou as palavras 
      await client.query('UPDATE words SET delivered = FALSE, date_delivered = NULL, who_delivered = \'SYSTEM\', assigned_at = NULL');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Erro ao resetar o banco de dados para o estado inicial:', err);
  }
};

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});

const waitUntilAvailable = async () => {
  let attempts = 0;
  const maxAttempts = 10;
  while (attempts < maxAttempts) {
    try {
      const client = await pool.connect();
      client.release();
      console.log('Banco de dados disponível!');
      return;
    } catch (err) {
      console.error(`Banco de dados indisponível. Tentativa ${attempts + 1}/${maxAttempts}`);
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  console.error('Tempo limite excedido. O banco de dados não está disponível.');
};

waitUntilAvailable().then(async () => {
  await createTableWords();
  //verify before populating
  pool.query('SELECT * FROM words')
    .then((res) => {
      if (res.rowCount === 0) {
        populateDatabase();
      } else {
        console.log('Banco de dados já populado!');
        //mostre os 10 primeiros registros
        pool.query('SELECT * FROM words ORDER BY index ASC LIMIT 100')
          .then((res) => {
            console.log(res.rows);
          });
      }
    })
    .catch((err) => {
      console.error('Erro ao verificar se o banco de dados está populado:', err);
    });
});

// Cron job para desatribuir palavras após 2 minutos
const checkWordTimeouts = async () => {
  try {
    const client = await pool.connect();
    try {
      let ntpTime = new Date();
      let actualDate = new Date();

      const result = await client.query(
        `UPDATE words 
         SET delivered = FALSE, who_delivered = 'SYSTEM', date_delivered = NULL, assigned_at = NULL 
         WHERE delivered = TRUE AND assigned_at IS NULL AND date_delivered < ($1::timestamp - INTERVAL '2 minutes')`,
        [actualDate]
      );
      if (result.rowCount > 0) {
        console.log(`Desatribuídas ${result.rowCount} palavras.`);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Erro ao desatribuir palavras:', err);
  }
};

cron.schedule('* * * * *', checkWordTimeouts); // Verifica a cada minuto
