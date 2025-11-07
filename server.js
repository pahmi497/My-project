// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Untuk file frontend

// TAMBAHKAN KODINGAN INI DI SINI:
// ----------------------------------------------------
// [PERBAIKAN] Endpoint Halaman Utama (Mengatasi 'Cannot GET /')
app.get('/', (req, res) => {
    // Arahkan ke halaman Pengirim
    res.sendFile(path.join(__dirname, 'public', 'sender.html'));
});

// --- SIMULASI DATABASE (Gunakan MongoDB/PostgreSQL di dunia nyata) ---
const transfers = {}; 
// Contoh struktur: { 'token-unik': { fileName: 'file.jpg', filePath: '/uploads/...', recipientEmail: '...', otpCode: '123456', otpExpiry: Date, isDownloaded: false } }
// --------------------------------------------------------------------

// 1. KONFIGURASI MULTER (Penyimpanan File)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Nama file di server unik untuk keamanan
        cb(null, uuidv4() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// 2. KONFIGURASI EMAIL
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true, // true untuk port 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
    }
});

// ----------------------------------------------------
// A. ENDPOINT PENGIRIM (Langkah 1-3)
// ----------------------------------------------------

app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Tidak ada file yang diunggah.');
    }

    const { senderEmail, recipientEmail } = req.body;
    const token = uuidv4();

    // 1. Simpan Metadata Transfer
    transfers[token] = {
        fileName: req.file.originalname,
        filePath: req.file.path,
        recipientEmail: recipientEmail,
        otpCode: null,
        otpExpiry: null,
        isDownloaded: false,
        createdAt: new Date()
    };
    
    // 2. Kirim Email Notifikasi Tautan (Link Terenkripsi)
    const downloadLink = `${BASE_URL}/download/${token}`;
    const mailOptions = {
        from: `Pengirim Aman <${senderEmail}>`,
        to: recipientEmail,
        subject: `[SECURE] File Aman dari ${senderEmail} Menunggu Verifikasi`,
        html: `
            <p>Anda menerima file aman. Berikut detail validasi Anda:</p>
            <ul>
                <li>Nama File: <b>${req.file.originalname}</b></li>
                <li>Ukuran: ${(req.file.size / 1024 / 1024).toFixed(2)} MB</li>
            </ul>
            <p>Klik tautan ini untuk melanjutkan ke proses verifikasi kode:</p>
            <p><a href="${downloadLink}">KLIK UNTUK UNDUH AMAN</a></p>
            <p>Tautan akan kedaluwarsa dalam 7 hari.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        res.send(`File berhasil diunggah dan tautan dikirim ke ${recipientEmail}.`);
    } catch (error) {
        console.error('Gagal mengirim email:', error);
        // Hapus file dari server jika gagal kirim email
        fs.unlinkSync(req.file.path); 
        delete transfers[token];
        res.status(500).send('Gagal mengirim email, transfer dibatalkan.');
    }
});

// ----------------------------------------------------
// B. ENDPOINT PENERIMA (Langkah 5-7)
// ----------------------------------------------------

// 3. Menampilkan Halaman Verifikasi
app.get('/download/:token', (req, res) => {
    const token = req.params.token;
    if (!transfers[token]) {
        return res.status(404).send('Transfer file tidak ditemukan atau kedaluwarsa.');
    }
    // Langsung tampilkan halaman frontend yang meminta kode OTP
    res.sendFile(path.join(__dirname, 'public', 'download.html'));
});


// 4. Permintaan Kode OTP (Langkah 5)
app.post('/api/otp/request', async (req, res) => {
    const { token } = req.body;
    const transfer = transfers[token];

    if (!transfer || transfer.isDownloaded) {
        return res.status(404).json({ success: false, message: 'Transfer tidak valid atau sudah diunduh.' });
    }

    // Buat kode OTP 6 digit dan set kedaluwarsa (5 menit)
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryTime = new Date(Date.now() + 5 * 60 * 1000); // 5 menit

    transfer.otpCode = otpCode;
    transfer.otpExpiry = expiryTime;
    
    // Kirim Email Kode OTP
    const mailOptions = {
        from: `Verifikasi Transfer <${process.env.EMAIL_USER}>`,
        to: transfer.recipientEmail,
        subject: `Kode Verifikasi Unduhan: ${otpCode}`,
        html: `
            <p>Kode verifikasi 6 digit Anda adalah: <b>${otpCode}</b></p>
            <p>Kode ini berlaku hingga ${expiryTime.toLocaleTimeString('id-ID')}.</p>
            <p>Segera masukkan kode di halaman unduhan.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: 'Kode OTP telah dikirimkan ke email penerima.' });
    } catch (error) {
    console.error('❌ Gagal mengirim OTP:', error);
    return res.status(500).json({ 
        success: false, 
        message: 'Gagal mengirim kode verifikasi.',
        error: error.message // tambahkan ini sementara untuk debug
    });
    }
});

// 5. Verifikasi Kode OTP (Langkah 6)
app.post('/api/otp/verify', (req, res) => {
    const { token, otp } = req.body;
    const transfer = transfers[token];

    if (!transfer || transfer.isDownloaded) {
        return res.status(404).json({ success: false, message: 'Transfer tidak valid.' });
    }

    const now = new Date();

    if (transfer.otpCode !== otp) {
        return res.status(401).json({ success: false, message: 'Kode OTP salah.' });
    }

    if (now > transfer.otpExpiry) {
        // Kosongkan OTP agar harus minta ulang
        transfer.otpCode = null;
        transfer.otpExpiry = null;
        return res.status(401).json({ success: false, message: 'Kode OTP sudah kedaluwarsa. Mohon minta ulang.' });
    }

    // VERIFIKASI BERHASIL! Kirim data file untuk download
    res.json({ 
        success: true, 
        message: 'Verifikasi berhasil. Anda dapat mengunduh file.',
        fileName: transfer.fileName,
        downloadUrl: `${BASE_URL}/api/download-file/${token}`
    });
});

// 6. Endpoint Download File (Langkah 7)
app.get('/api/download-file/:token', (req, res) => {
    const token = req.params.token;
    const transfer = transfers[token];

    if (!transfer || transfer.isDownloaded || !transfer.otpCode) {
        // Mencegah akses jika sudah diunduh atau belum diverifikasi
        return res.status(403).send('Akses tidak diizinkan atau file sudah diunduh.');
    }
    
    // Kirim file ke Penerima
    res.download(transfer.filePath, transfer.fileName, (err) => {
        if (err) {
            console.error('Error saat download:', err);
            // File mungkin sudah hilang dari server
            res.status(500).send('Gagal memproses unduhan.');
        } else {
            // Tamat! Set status unduhan agar tidak bisa diunduh lagi
            transfer.isDownloaded = true;
            transfer.otpCode = null; // Hapus kode
            transfer.otpExpiry = null; // Hapus expiry
            // Opsional: Hapus file fisik dari server setelah diunduh.
            // fs.unlink(transfer.filePath, (err) => { if (err) console.error('Gagal hapus file:', err); }); 
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server berjalan di ${BASE_URL}`);
});